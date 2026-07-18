"use strict";

/**
 * processPrescription/index.js
 *
 * Flow:
 *   1. Receive imageKey/imageKeys + user context from frontend
 *   2. Fetch prescription image(s) from S3
 *   3. Send image(s) to Bedrock Claude → get structured JSON
 *   4. Save prescription to DynamoDB
 *   5. Create per-dose EventBridge Scheduler rules (Option A)
 *   6. Save full schedule to DynamoDB (for Option B daily summary)
 *   7. Return parsed prescription + schedule summary to frontend
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SchedulerClient, CreateScheduleCommand } = require("@aws-sdk/client-scheduler");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { createHash, createHmac } = require("crypto");

// Pure scheduling logic (validation, recurring expansion, past-dose skip,
// schedule-name building) lives in scheduling.js so it can be unit-tested
// without AWS. See backend/tests/scheduling.test.js.
const {
  MAX_IMAGES,
  validateImageKeys,
  buildDosesToSchedule,
  doseToUtc,
  isDosePast,
  buildScheduleName,
  isTotalScheduleFailure,
} = require("./scheduling");

// Stable error codes + response builder (see backend/tests/errors.test.js). The
// frontend maps these codes to user-facing copy in frontend/src/errors.js.
const { CODES, ProcessingError, errorResponse } = require("./errors");

const BEDROCK_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// ─── AWS clients ─────────────────────────────────────────────────────────────
const bedrock   = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
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
  MAGIC_LINK_SECRET,
} = process.env;

// ─── Session token signing ────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function signSessionToken(userId) {
  if (!MAGIC_LINK_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  const sig = createHmac("sha256", MAGIC_LINK_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Create a single EventBridge Scheduler rule for one dose event.
 * The rule fires once at the exact dose time, then auto-deletes.
 */
async function createDoseSchedule({ scheduleId, dose, userId, userTimezone, notificationMethod, contactInfo }) {
  if (!dose.date || !dose.time) {
    console.log("Skipping dose with no date/time:", dose);
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

// ─── TTL helper ───────────────────────────────────────────────────────────────
// DynamoDB TTL is Unix timestamp (seconds)
function ttlOneYear() {
  return Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
}

function shortHash(value, length = 32) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function getIdempotencyKey({ uploadId, keys, userId }) {
  const source = uploadId || keys.join("|");
  return shortHash(`${userId}:${source}`, 40);
}

function responseFromCompletedSchedule(schedule, headers, replay = false) {
  const medications = schedule.prescription?.medications || schedule.medications || [];
  const scheduledDoses = schedule.scheduledDoses || [];
  const skippedDoses = schedule.skippedDoses || [];
  const sessionToken = schedule.userId ? signSessionToken(schedule.userId) : null;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      idempotentReplay: replay,
      prescriptionId: schedule.prescriptionId,
      scheduleId: schedule.scheduleId,
      sessionToken,
      ...(replay ? { samePrescriptionId: true, sameScheduleId: true } : {}),
      prescription: schedule.prescription || { medications },
      summary: {
        medicationsFound: medications.length,
        dosesScheduled: scheduledDoses.length,
        dosesSkipped: skippedDoses.length,
        skippedReason: skippedDoses.length > 0 ? "Doses in the past or PRN medications are not scheduled" : null,
      },
      message: `Found ${medications.length} medication(s). ${scheduledDoses.length} dose reminder(s) scheduled.`,
    }),
  };
}

async function getExistingSchedule(userId, scheduleId) {
  const result = await dynamo.send(new GetCommand({
    TableName: SCHEDULES_TABLE,
    Key: { userId, scheduleId },
  }));
  return result.Item;
}

async function markScheduleFailed({ userId, scheduleId, message }) {
  if (!userId || !scheduleId) return;

  try {
    await dynamo.send(new UpdateCommand({
      TableName: SCHEDULES_TABLE,
      Key: { userId, scheduleId },
      UpdateExpression: "SET #status = :failed, #active = :false, failureMessage = :message, updatedAt = :now",
      ExpressionAttributeNames: {
        "#status": "processingStatus",
        "#active": "active",
      },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":false": false,
        ":message": message,
        ":now": new Date().toISOString(),
      },
    }));
  } catch (error) {
    console.error(`[${userId}] Failed to mark idempotent schedule as failed:`, error.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Surfaced in error responses so a user can quote it to support and we can
  // grep the exact invocation in CloudWatch.
  const requestId = context?.awsRequestId;

  let lockedSchedule = null;

  try {
    const body = JSON.parse(event.body || "{}");

    const {
      imageKey,          // S3 key of the uploaded prescription image (legacy single-image path)
      imageKeys,         // S3 keys of uploaded prescription images (multi-page path)
      uploadId,          // shared S3 prefix segment for one prescription upload
      userId,            // Cognito user sub (unique per user)
      userTimezone,      // IANA timezone string e.g. "Asia/Manila"
      notificationMethod,// "sms" | "email"
      contactInfo,       // phone number (+63...) or email address
    } = body;

    // ── Validation ────────────────────────────────────────────────────────
    const { keys, error: imageKeysError } = validateImageKeys({ imageKey, imageKeys });
    if (imageKeysError) return errorResponse({ headers, requestId, ...imageKeysError });
    if (!userId)    return errorResponse({ headers, requestId, statusCode: 400, code: CODES.MISSING_USER, message: "userId is required" });
    if (!contactInfo) return errorResponse({ headers, requestId, statusCode: 400, code: CODES.MISSING_CONTACT, message: "contactInfo (phone or email) is required" });

    const timezone = userTimezone || "Asia/Manila";
    const idempotencyKey = getIdempotencyKey({ uploadId, keys, userId });
    const prescriptionId = `rx-${idempotencyKey}`;
    const scheduleId = `sched-${idempotencyKey}`;
    const now = new Date().toISOString();
    const expiresAt = ttlOneYear();

    // Acquire an idempotency lock before any expensive or side-effecting work.
    // A duplicate request with the same uploadId should not call Bedrock or
    // create another batch of EventBridge schedules.
    try {
      await dynamo.send(new PutCommand({
        TableName: SCHEDULES_TABLE,
        Item: {
          userId,
          scheduleId,
          prescriptionId,
          uploadId,
          imageKeys: keys,
          idempotencyKey,
          processingStatus: "processing",
          active: false,
          userTimezone: timezone,
          notificationMethod: notificationMethod || "sms",
          contactInfo,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(scheduleId)",
      }));
      lockedSchedule = { userId, scheduleId };
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;

      const existing = await getExistingSchedule(userId, scheduleId);
      if (existing?.processingStatus === "complete") {
        console.log(`[${userId}] Returning idempotent schedule replay for ${scheduleId}`);
        return responseFromCompletedSchedule(existing, headers, true);
      }

      if (existing?.processingStatus === "failed") {
        return errorResponse({
          headers,
          requestId,
          statusCode: 409,
          code: CODES.PREVIOUS_UPLOAD_FAILED,
          message: "This upload already failed. Please choose the prescription pages again to start a fresh upload.",
        });
      }

      return errorResponse({
        headers,
        requestId,
        statusCode: 409,
        code: CODES.DUPLICATE_IN_PROGRESS,
        message: "This prescription is already being processed. Please wait for the current request to finish.",
      });
    }

    // ── Step 1: Get image(s) from S3 ──────────────────────────────────────
    console.log(`[${userId}] Fetching ${keys.length} image(s): ${keys.join(", ")}`);
    const images = await Promise.all(keys.map(getImageFromS3));

    // ── Step 2: Call Bedrock Claude ───────────────────────────────────────
    console.log(`[${userId}] Calling Bedrock (model: ${BEDROCK_MODEL_ID})`);
    const rawResponse = await callBedrock(images);
    console.log(`[${userId}] Raw Bedrock response:`, rawResponse.substring(0, 200));

    let prescription;
    try {
      prescription = parsePrescription(rawResponse);
    } catch (parseError) {
      console.error("Parse error:", parseError.message);
      console.error("Raw response was:", rawResponse);
      await markScheduleFailed({ userId, scheduleId, message: parseError.message });
      return errorResponse({
        headers,
        requestId,
        statusCode: 422,
        code: CODES.IMAGE_UNREADABLE,
        message: "Could not read this prescription. The image may be too blurry or not a valid prescription.",
        detail: parseError.message,
      });
    }

    // ── Step 3: Save prescription to DynamoDB ─────────────────────────────
    await dynamo.send(new PutCommand({
      TableName: PRESCRIPTIONS_TABLE,
      Item: {
        userId,
        prescriptionId,
        imageKey: keys[0],
        imageKeys: keys,
        uploadId,
        idempotencyKey,
        prescription,
        createdAt: now,
        expiresAt,
      },
    }));
    console.log(`[${userId}] Saved prescription ${prescriptionId}`);

    // ── Step 4: Create per-dose EventBridge rules (Option A) ──────────────
    const scheduledDoses = [];

    // Phase 1: flatten every medication into a list of dated dose objects.
    // PRN medications and as-needed doses are skipped; recurring/date-less
    // doses are expanded (one per day across the window); tapers pass through.
    // The rules live in scheduling.js — see backend/tests/scheduling.test.js.
    const { dosesToSchedule, skippedDoses } = buildDosesToSchedule(prescription, timezone);

    // Phase 2: create all EventBridge rules in parallel. With recurring meds a
    // prescription can expand to dozens of doses; running these sequentially
    // would add seconds and risk the API Gateway 30s timeout.
    console.log(`[${userId}] Creating ${dosesToSchedule.length} schedule(s) in parallel`);
    const results = await Promise.allSettled(
      dosesToSchedule.map((doseWithMed) =>
        createDoseSchedule({
          scheduleId,
          dose: doseWithMed,
          userId,
          userTimezone: timezone,
          notificationMethod: notificationMethod || "sms",
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
        console.error(`Failed to schedule dose for ${doseWithMed.medication} on ${doseWithMed.date}:`, result.reason?.message);
        skippedDoses.push(doseWithMed);
      }
    });

    // If we parsed the prescription but every reminder creation errored, that is
    // a real failure — surface it instead of a misleading "0 reminders" success.
    if (isTotalScheduleFailure(dosesToSchedule.length, scheduledDoses.length, creationErrors)) {
      console.error(`[${userId}] All ${dosesToSchedule.length} schedule creation(s) failed`);
      await markScheduleFailed({ userId, scheduleId, message: "All schedule creations failed" });
      return errorResponse({
        headers,
        requestId,
        statusCode: 502,
        code: CODES.SCHEDULE_CREATE_FAILED,
        message: "We read your prescription but couldn't set up any reminders. Please try again.",
        detail: `0 of ${dosesToSchedule.length} reminders created`,
      });
    }

    // ── Step 5: Save schedule to DynamoDB (for Option B daily summary) ─────
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
        "userTimezone = :timezone",
        "notificationMethod = :notificationMethod",
        "contactInfo = :contactInfo",
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
        ":timezone": timezone,
        ":notificationMethod": notificationMethod || "sms",
        ":contactInfo": contactInfo,
        ":now": new Date().toISOString(),
        ":expiresAt": expiresAt,
      },
    }));
    console.log(`[${userId}] Saved schedule ${scheduleId} with ${scheduledDoses.length} dose reminders`);

    // ── Step 5b: Send subscription confirmation email (server-side) ───────
    // Done here via a direct async Lambda invoke rather than the browser
    // calling the public /notify-test endpoint — keeps that endpoint off the
    // critical path so it can be locked down. Fire-and-forget: never blocks or
    // fails the response.
    if ((notificationMethod || "sms") === "email" && contactInfo && NOTIFIER_FUNCTION_ARN) {
      try {
        await lambda.send(new InvokeCommand({
          FunctionName: NOTIFIER_FUNCTION_ARN,
          InvocationType: "Event", // async — don't wait for the email to send
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
        console.log(`[${userId}] Queued subscription confirmation email`);
      } catch (notifyError) {
        console.error(`[${userId}] Failed to queue subscription email:`, notifyError.message);
      }
    }

    // ── Step 6: Respond to frontend ───────────────────────────────────────
    return responseFromCompletedSchedule({
      userId,
      prescriptionId,
      scheduleId,
      prescription,
      medications: prescription.medications,
      scheduledDoses,
      skippedDoses,
    }, headers);

  } catch (error) {
    console.error("Unhandled error:", error);
    await markScheduleFailed({ ...lockedSchedule, message: error.message });

    // A typed ProcessingError (e.g. unsupported file type from getImageFromS3)
    // carries its own status/code; anything else is an unclassified 500.
    if (error instanceof ProcessingError) {
      return errorResponse({
        headers,
        requestId,
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
        detail: error.detail,
      });
    }

    return errorResponse({
      headers,
      requestId,
      statusCode: 500,
      code: CODES.PROCESSING_FAILED,
      message: "Something went wrong processing this prescription. Please try again.",
      detail: error.message,
    });
  }
};
