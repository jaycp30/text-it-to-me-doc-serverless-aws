"use strict";

/**
 * processPrescription/worker.js
 *
 * The slow half of the pipeline, invoked ASYNCHRONOUSLY by index.js:
 *   1. Re-read the locked schedule record (the API handler already wrote it)
 *   2. Fetch prescription image(s) from S3
 *   3. Send image(s) to Bedrock Claude → structured JSON
 *   4. Save the prescription, create per-dose EventBridge Scheduler rules
 *   5. Complete the schedule record, queue the confirmation email
 *
 * Why this is separate: API Gateway caps a synchronous integration at 30
 * seconds and Bedrock routinely needs 30–60s on a busy prescription, so the
 * old single-call design failed exactly on the prescriptions that mattered
 * most. Running asynchronously lifts that ceiling using Lambda's ordinary
 * 15-minute async limit — no Managed Instances and no pricing change.
 *
 * Invocation payload is deliberately just { userId, scheduleId }. Everything
 * else (imageKeys, contactInfo, timezone, notification method) is read back
 * from the locked record, so contact details never travel in an invoke
 * payload and the record stays the single source of truth.
 *
 * There are NO automatic retries (MaximumRetryAttempts: 0 in template.yaml).
 * A retry after a successful Bedrock call would pay for that call twice, and
 * Bedrock is this stack's main cost risk. Failures are recorded on the record
 * with a stable code and surfaced to the user, who can retry deliberately.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SchedulerClient, CreateScheduleCommand } = require("@aws-sdk/client-scheduler");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const {
  buildDosesToSchedule,
  doseToUtc,
  isDosePast,
  buildScheduleName,
  isTotalScheduleFailure,
} = require("./scheduling");

const { CODES, ProcessingError } = require("./errors");

const {
  dynamo,
  STAGES,
  ttlOneYear,
  getExistingSchedule,
  setProcessingStage,
  markScheduleFailed,
} = require("./shared");

const BEDROCK_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// ─── AWS clients ─────────────────────────────────────────────────────────────
const bedrock   = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const s3        = new S3Client({});
const scheduler = new SchedulerClient({});
const lambda    = new LambdaClient({});

// ─── Env vars ─────────────────────────────────────────────────────────────────
const {
  BEDROCK_MODEL_ID,
  PRESCRIPTIONS_TABLE,
  SCHEDULES_TABLE,
  IMAGES_BUCKET,
  SCHEDULER_GROUP,
  NOTIFIER_FUNCTION_ARN,
  SCHEDULER_ROLE_ARN,
} = process.env;

// ─── System prompt ────────────────────────────────────────────────────────────
// This is the most important part — it tells Claude exactly what to extract
// and how to handle edge cases like tapers, ditto marks, shorthand, etc.
const SYSTEM_PROMPT = `You are a medical prescription interpreter specialising in handwritten doctor's prescriptions.
Your job is to extract every medication instruction from the prescription image into precise, structured JSON.

INTERPRETATION RULES:
- Ditto marks ("") mean "same instruction as the line above" — expand them fully
- Taper schedules (different dose each day) must list every single day explicitly
- Shorthand to expand:
    tab/tabs = tablet, cap/caps = capsule, gtts/gtt = drops
    od/qd = once daily, bid = twice daily, tid = 3x daily, qid = 4x daily
    pc = after meals, ac = before meals, hs = at bedtime, prn = as needed
    qXh = every X hours (e.g. q4h = every 4 hours)
- Time mapping (use these defaults when no specific time is given):
    after breakfast / morning → "08:00"
    after lunch / midday      → "13:00"
    after dinner / evening    → "19:00"
    bedtime / hs              → "22:00"
    "every 4 hours"           → ["08:00", "12:00", "16:00", "20:00"]
    "every 6 hours"           → ["06:00", "12:00", "18:00", "00:00"]
- All dates must be ISO 8601 format: YYYY-MM-DD
- If a date is written as month/day (e.g. 5/29), infer the year from context
- PRN (as needed) medications: set schedule_type to "prn" and skip creating time-based doses
- Eye drops, topical, or recurring medications with no end date: set end_date to null

CRITICAL: Respond ONLY with valid JSON. No markdown, no backticks, no explanation.

OUTPUT SCHEMA:
{
  "prescription_date": "YYYY-MM-DD or null",
  "doctor": "doctor name if readable, else null",
  "patient": "patient name if readable, else null",
  "medications": [
    {
      "name": "generic drug name (lowercase)",
      "brand": "brand name as written, or null",
      "form": "tablet | capsule | drops | syrup | cream | injection",
      "dose_mg": 10,
      "quantity": 29,
      "schedule_type": "fixed | taper | prn | recurring",
      "doses": [
        {
          "date": "YYYY-MM-DD (null for recurring/prn)",
          "time": "HH:MM (24h format)",
          "amount": 6,
          "unit": "tablet | capsule | drop | ml",
          "instruction": "human readable e.g. after breakfast",
          "as_needed": false,
          "notes": "e.g. right eye only"
        }
      ],
      "duration_days": 7,
      "end_date": "YYYY-MM-DD or null",
      "special_instructions": "any notes like take with food, avoid sunlight, etc."
    }
  ]
}`;

// ─── Image helpers ────────────────────────────────────────────────────────────

/**
 * Fetch an image from S3 and return it as base64 with content type.
 */
async function getImageFromS3(imageKey) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: IMAGES_BUCKET,
    Key: imageKey,
  }));

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const contentType = detectImageContentType(buffer, response.ContentType);

  if (!BEDROCK_IMAGE_TYPES.has(contentType)) {
    throw new ProcessingError(
      CODES.UNSUPPORTED_FILE,
      415,
      "That file type isn't supported. Please upload JPEG, PNG, or WebP images.",
      `Unsupported image type ${contentType}`,
    );
  }

  return {
    base64: buffer.toString("base64"),
    contentType,
  };
}

function normalizeContentType(contentType) {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  return type === "image/jpg" ? "image/jpeg" : type;
}

function detectImageContentType(buffer, fallback) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (brand.startsWith("hei") || brand.startsWith("mif")) {
      return "image/heic";
    }
  }

  return normalizeContentType(fallback) || "image/jpeg";
}

// ─── Bedrock ──────────────────────────────────────────────────────────────────

/**
 * Call Bedrock Claude with the prescription image(s).
 * Returns raw text response (should be JSON string).
 */
async function callBedrock(images) {
  const imageBlocks = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.contentType,
      data: image.base64,
    },
  }));

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks,
          {
            type: "text",
            text: images.length > 1
              ? "These images are pages or screenshots from the same prescription. Read them together in order and extract all medication instructions into the JSON format specified. Be thorough — expand all ditto marks and shorthand."
              : "Read this prescription and extract all medication instructions into the JSON format specified. Be thorough — expand all ditto marks and shorthand.",
          },
        ],
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    body: JSON.stringify(payload),
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await bedrock.send(command);
  const body = JSON.parse(Buffer.from(response.body).toString("utf-8"));

  // Claude response is in body.content[0].text
  return body.content?.[0]?.text || "";
}

/**
 * Parse Bedrock's response into a JavaScript object.
 * Handles cases where Claude adds markdown fences despite being told not to.
 */
function parsePrescription(rawText) {
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: find the first JSON object in the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Could not parse prescription JSON from Bedrock response");
  }
}

// ─── EventBridge Scheduler ────────────────────────────────────────────────────

/**
 * Create a single EventBridge Scheduler rule for one dose event.
 * The rule fires once at the exact dose time, then auto-deletes.
 */
async function createDoseSchedule({ scheduleId, dose, userId, userTimezone, notificationMethod, contactInfo }) {
  if (!dose.date || !dose.time) {
    // Reason only — the dose object carries the medication name. The caller
    // returns the full skippedDoses list to the frontend, so nothing is lost.
    console.log("Skipping dose with no date/time");
    return null;
  }

  // Skip doses in the past
  if (isDosePast(dose, userTimezone)) {
    console.log(`Skipping past dose: ${dose.date} ${dose.time} (${userTimezone})`);
    return null;
  }

  // Convert local dose time to UTC for the "at()" expression below.
  const utcDT = doseToUtc(dose, userTimezone);

  // Collision-proof rule name, hard-capped at 64 chars (see scheduling.js).
  const safeName = buildScheduleName(dose);

  const command = new CreateScheduleCommand({
    Name: safeName,
    GroupName: SCHEDULER_GROUP,
    // "at()" means fire exactly once at this UTC timestamp
    ScheduleExpression: `at(${utcDT.toFormat("yyyy-MM-dd'T'HH:mm:ss")})`,
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    Target: {
      Arn: NOTIFIER_FUNCTION_ARN,
      RoleArn: SCHEDULER_ROLE_ARN,
      // This payload goes directly to the NotifyUser Lambda
      Input: JSON.stringify({
        userId,
        scheduleId,
        dose,
        notificationMethod,
        contactInfo,
      }),
    },
    // Auto-delete the schedule rule after it fires — no cleanup needed
    ActionAfterCompletion: "DELETE",
  });

  await scheduler.send(command);
  return safeName;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports.handler = async (event) => {
  const { userId, scheduleId } = event || {};

  if (!userId || !scheduleId) {
    // Nothing to fail against — no record to mark, so just surface it loudly.
    console.error("Worker invoked without userId/scheduleId; dropping");
    return { ok: false, reason: "missing identifiers" };
  }

  console.log(`[${userId}] Worker started for ${scheduleId}`);

  // Everything the job needs was written by the API handler when it claimed
  // the idempotency lock, so the payload stays free of contact details.
  const job = await getExistingSchedule(userId, scheduleId);

  if (!job) {
    console.error(`[${userId}] No schedule record for ${scheduleId}; dropping`);
    return { ok: false, reason: "no record" };
  }

  // A completed record means a duplicate delivery of the same async event.
  // Lambda async is at-least-once, so this is expected rather than an error —
  // and re-running would pay for Bedrock twice.
  if (job.processingStatus === "complete") {
    console.log(`[${userId}] ${scheduleId} already complete; skipping duplicate delivery`);
    return { ok: true, skipped: "already complete" };
  }

  const keys = job.imageKeys || [];
  const timezone = job.userTimezone || "Asia/Manila";
  const notificationMethod = job.notificationMethod || "sms";
  const contactInfo = job.contactInfo;
  const prescriptionId = job.prescriptionId;
  const now = new Date().toISOString();
  const expiresAt = ttlOneYear();

  try {
    // ── Step 1: Get image(s) from S3 ──────────────────────────────────────
    await setProcessingStage(userId, scheduleId, STAGES.READING);
    console.log(`[${userId}] Fetching ${keys.length} image(s)`);
    const images = await Promise.all(keys.map(getImageFromS3));

    // ── Step 2: Call Bedrock Claude ───────────────────────────────────────
    console.log(`[${userId}] Calling Bedrock (model: ${BEDROCK_MODEL_ID})`);
    const rawResponse = await callBedrock(images);
    // Shape only — the body of this response is the extracted medication data.
    console.log(`[${userId}] Bedrock responded (${rawResponse.length} chars)`);

    let prescription;
    try {
      prescription = parsePrescription(rawResponse);
    } catch (parseError) {
      // The unparseable body may still contain extracted medication data, so
      // log its length rather than its contents.
      console.error(`[${userId}] Parse error (${rawResponse.length} chars):`, parseError.message);
      await markScheduleFailed({
        userId,
        scheduleId,
        message: "Could not read this prescription. The image may be too blurry or not a valid prescription.",
        code: CODES.IMAGE_UNREADABLE,
      });
      return { ok: false, code: CODES.IMAGE_UNREADABLE };
    }

    // ── Step 3: Save prescription to DynamoDB ─────────────────────────────
    await dynamo.send(new PutCommand({
      TableName: PRESCRIPTIONS_TABLE,
      Item: {
        userId,
        prescriptionId,
        imageKey: keys[0],
        imageKeys: keys,
        uploadId: job.uploadId,
        idempotencyKey: job.idempotencyKey,
        prescription,
        createdAt: now,
        expiresAt,
        // Evidence of the Article 9 explicit consent this record was created
        // under. Stored next to the data it authorises so the two cannot drift.
        consentAt: job.consentAt,
        policyVersion: job.policyVersion,
      },
    }));
    console.log(`[${userId}] Saved prescription ${prescriptionId}`);

    // ── Step 4: Create per-dose EventBridge rules ─────────────────────────
    await setProcessingStage(userId, scheduleId, STAGES.SCHEDULING);
    const scheduledDoses = [];

    // Phase 1: flatten every medication into a list of dated dose objects.
    // PRN medications and as-needed doses are skipped; recurring/date-less
    // doses are expanded (one per day across the window); tapers pass through.
    const { dosesToSchedule, skippedDoses } = buildDosesToSchedule(prescription, timezone);

    // Phase 2: create all EventBridge rules in parallel. With recurring meds a
    // prescription can expand to dozens of doses; running these sequentially
    // would add seconds for no benefit.
    console.log(`[${userId}] Creating ${dosesToSchedule.length} schedule(s) in parallel`);
    const results = await Promise.allSettled(
      dosesToSchedule.map((doseWithMed) =>
        createDoseSchedule({
          scheduleId,
          dose: doseWithMed,
          userId,
          userTimezone: timezone,
          notificationMethod,
          contactInfo,
        })
      )
    );

    // Count genuine creation errors (rejections) separately from past-dose
    // skips (fulfilled-but-null) so we can tell a total failure apart from a
    // prescription that simply had nothing left to schedule.
    let creationErrors = 0;
    results.forEach((result, i) => {
      const doseWithMed = dosesToSchedule[i];
      if (result.status === "fulfilled" && result.value) {
        scheduledDoses.push({ ...doseWithMed, scheduleName: result.value });
      } else if (result.status === "fulfilled") {
        // null = skipped (past dose)
        skippedDoses.push(doseWithMed);
      } else {
        creationErrors++;
        console.error(`[${userId}] Failed to schedule a dose:`, result.reason?.message);
        skippedDoses.push(doseWithMed);
      }
    });

    // If we parsed the prescription but every reminder creation errored, that is
    // a real failure — surface it instead of a misleading "0 reminders" success.
    if (isTotalScheduleFailure(dosesToSchedule.length, scheduledDoses.length, creationErrors)) {
      console.error(`[${userId}] All ${dosesToSchedule.length} schedule creation(s) failed`);
      await markScheduleFailed({
        userId,
        scheduleId,
        message: "We read your prescription but couldn't set up any reminders. Please try again.",
        code: CODES.SCHEDULE_CREATE_FAILED,
      });
      return { ok: false, code: CODES.SCHEDULE_CREATE_FAILED };
    }

    // ── Step 5: Queue the confirmation email ──────────────────────────────
    // Queued BEFORE the record is marked complete, so `confirmation` lands in
    // the same write as the completion below. Splitting them would let a poll
    // catch "complete" a moment before the confirmation existed, and the UI
    // would report an unknown confirmation state for an email that was sent.
    //
    // Async invoke, so a slow SES call never delays completion. `queued` means
    // the send was accepted, not delivered — the UI offers a resend for the
    // "queued but never arrived" case.
    let confirmation = null;
    if (notificationMethod === "email" && contactInfo && NOTIFIER_FUNCTION_ARN) {
      let queued = false;
      try {
        await lambda.send(new InvokeCommand({
          FunctionName: NOTIFIER_FUNCTION_ARN,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({
            type: "subscribed",
            userId,
            notificationMethod: "email",
            contactInfo,
            medications: prescription.medications || [],
            dosesScheduled: scheduledDoses.length,
            userTimezone: timezone,
          })),
        }));
        queued = true;
        console.log(`[${userId}] Queued subscription confirmation email`);
      } catch (notifyError) {
        console.error(`[${userId}] Failed to queue subscription email:`, notifyError.message);
      }
      confirmation = { channel: "email", queued };
    }

    // ── Step 6: Complete the schedule record ──────────────────────────────
    // This write is what the polling client is waiting for, so everything the
    // client needs must already be in it.
    await setProcessingStage(userId, scheduleId, STAGES.FINISHING);
    await dynamo.send(new UpdateCommand({
      TableName: SCHEDULES_TABLE,
      Key: { userId, scheduleId },
      UpdateExpression: [
        "SET #status = :complete",
        "#active = :true",
        "prescription = :prescription",
        "medications = :medications",
        "scheduledDoses = :scheduledDoses",
        "skippedDoses = :skippedDoses",
        "confirmation = :confirmation",
        "updatedAt = :now",
        "expiresAt = :expiresAt",
      ].join(", "),
      ExpressionAttributeNames: {
        "#status": "processingStatus",
        "#active": "active",
      },
      ExpressionAttributeValues: {
        ":complete": "complete",
        ":true": true,
        ":prescription": prescription,
        ":medications": prescription.medications,
        ":scheduledDoses": scheduledDoses,
        ":skippedDoses": skippedDoses,
        ":confirmation": confirmation,
        ":now": new Date().toISOString(),
        ":expiresAt": expiresAt,
      },
    }));
    console.log(`[${userId}] Saved schedule ${scheduleId} with ${scheduledDoses.length} dose reminders`);

    return { ok: true, scheduleId, dosesScheduled: scheduledDoses.length };

  } catch (error) {
    console.error(`[${userId}] Worker failed:`, error.message);

    // A typed ProcessingError (e.g. unsupported file type from getImageFromS3)
    // carries its own stable code; anything else is unclassified.
    const code = error instanceof ProcessingError ? error.code : CODES.PROCESSING_FAILED;
    const message = error instanceof ProcessingError
      ? error.message
      : "Something went wrong processing this prescription. Please try again.";

    await markScheduleFailed({ userId, scheduleId, message, code });
    return { ok: false, code };
  }
};
