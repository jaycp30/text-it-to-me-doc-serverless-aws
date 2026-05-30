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
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SchedulerClient, CreateScheduleCommand } = require("@aws-sdk/client-scheduler");
const { DateTime } = require("luxon");
const { randomUUID } = require("crypto");

const MAX_IMAGES = 5;
const BEDROCK_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// ─── AWS clients ─────────────────────────────────────────────────────────────
const bedrock   = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3        = new S3Client({});
const scheduler = new SchedulerClient({});

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
    throw new Error(`Unsupported image type ${contentType}. Please upload JPEG, PNG, or WebP images.`);
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

  // Convert local dose time to UTC
  const localDT = DateTime.fromISO(`${dose.date}T${dose.time}`, { zone: userTimezone });
  const utcDT = localDT.toUTC();

  // Skip doses in the past
  if (utcDT < DateTime.utc()) {
    console.log(`Skipping past dose: ${dose.date} ${dose.time} (${userTimezone})`);
    return null;
  }

  // EventBridge schedule name must match [a-zA-Z0-9-_.] and be unique
  const safeName = `rx-${scheduleId}-${dose.date}-${dose.time.replace(":", "")}-${dose.medication}`
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .substring(0, 512);  // max length

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

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

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
    const keys = Array.isArray(imageKeys) ? imageKeys : imageKey ? [imageKey] : [];
    if (!keys.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "imageKey or imageKeys is required" }) };
    if (keys.length > MAX_IMAGES) return { statusCode: 400, headers, body: JSON.stringify({ error: `A maximum of ${MAX_IMAGES} images can be processed at once` }) };
    if (!userId)    return { statusCode: 400, headers, body: JSON.stringify({ error: "userId is required" }) };
    if (!contactInfo) return { statusCode: 400, headers, body: JSON.stringify({ error: "contactInfo (phone or email) is required" }) };

    const timezone = userTimezone || "Asia/Manila";

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
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: "Could not read this prescription. The image may be too blurry or not a valid prescription.",
          detail: parseError.message,
        }),
      };
    }

    const prescriptionId = randomUUID();
    const scheduleId = randomUUID();
    const now = new Date().toISOString();

    // ── Step 3: Save prescription to DynamoDB ─────────────────────────────
    await dynamo.send(new PutCommand({
      TableName: PRESCRIPTIONS_TABLE,
      Item: {
        userId,
        prescriptionId,
        imageKey: keys[0],
        imageKeys: keys,
        uploadId,
        prescription,
        createdAt: now,
        expiresAt: ttlOneYear(),
      },
    }));
    console.log(`[${userId}] Saved prescription ${prescriptionId}`);

    // ── Step 4: Create per-dose EventBridge rules (Option A) ──────────────
    const scheduledDoses = [];
    const skippedDoses = [];

    for (const med of prescription.medications || []) {
      // Skip PRN (as needed) — these have no fixed schedule
      if (med.schedule_type === "prn") {
        console.log(`[${userId}] Skipping PRN medication: ${med.name}`);
        continue;
      }

      for (const dose of med.doses || []) {
        if (dose.as_needed) continue;

        const doseWithMed = {
          medication: med.name,
          brand: med.brand,
          form: med.form,
          dose_mg: med.dose_mg,
          special_instructions: med.special_instructions,
          ...dose,
        };

        try {
          const scheduleName = await createDoseSchedule({
            scheduleId,
            dose: doseWithMed,
            userId,
            userTimezone: timezone,
            notificationMethod: notificationMethod || "sms",
            contactInfo,
          });

          if (scheduleName) {
            scheduledDoses.push({ ...doseWithMed, scheduleName });
          } else {
            skippedDoses.push(doseWithMed);
          }
        } catch (scheduleError) {
          // Don't fail the whole request if one schedule fails
          console.error(`Failed to schedule dose for ${med.name} on ${dose.date}:`, scheduleError.message);
          skippedDoses.push(doseWithMed);
        }
      }
    }

    // ── Step 5: Save schedule to DynamoDB (for Option B daily summary) ─────
    await dynamo.send(new PutCommand({
      TableName: SCHEDULES_TABLE,
      Item: {
        userId,
        scheduleId,
        prescriptionId,
        medications: prescription.medications,
        scheduledDoses,
        skippedDoses,
        userTimezone: timezone,
        notificationMethod: notificationMethod || "sms",
        contactInfo,
        active: true,
        createdAt: now,
        expiresAt: ttlOneYear(),
      },
    }));
    console.log(`[${userId}] Saved schedule ${scheduleId} with ${scheduledDoses.length} dose reminders`);

    // ── Step 6: Respond to frontend ───────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        prescriptionId,
        scheduleId,
        prescription,
        summary: {
          medicationsFound: prescription.medications?.length || 0,
          dosesScheduled: scheduledDoses.length,
          dosesSkipped: skippedDoses.length,
          skippedReason: skippedDoses.length > 0 ? "Doses in the past or PRN medications are not scheduled" : null,
        },
        message: `Found ${prescription.medications?.length || 0} medication(s). ${scheduledDoses.length} dose reminder(s) scheduled.`,
      }),
    };

  } catch (error) {
    console.error("Unhandled error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Something went wrong processing this prescription. Please try again.",
        detail: error.message,
      }),
    };
  }
};
