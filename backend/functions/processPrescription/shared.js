"use strict";

/**
 * shared.js
 *
 * State shared by both halves of the prescription pipeline:
 *
 *   index.js  — the synchronous API handler behind POST /process. Validates,
 *               claims the idempotency lock, hands off, and returns 202.
 *   worker.js — the asynchronous worker. Does the slow work (S3 → Bedrock →
 *               EventBridge) with no API Gateway timeout over its head.
 *
 * Everything here touches the schedules table or derives a value from it. The
 * split exists because API Gateway caps a synchronous integration at 30
 * seconds while Bedrock routinely needs 30–60s on a busy prescription; see
 * issue #5.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { createHash, createHmac } = require("crypto");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const { SCHEDULES_TABLE, MAGIC_LINK_SECRET } = process.env;

// Stages the worker reports as it progresses, mirroring the frontend's
// PROCESSING_STAGE_ORDER. The frontend previously guessed the stage from
// elapsed time; now it reflects where the job actually is.
const STAGES = Object.freeze({
  READING:    "reading",
  SCHEDULING: "scheduling",
  FINISHING:  "finishing",
});

// ─── Session token signing ────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function signSessionToken(userId) {
  if (!MAGIC_LINK_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  const sig = createHmac("sha256", MAGIC_LINK_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
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

// ─── Schedule record access ───────────────────────────────────────────────────

async function getExistingSchedule(userId, scheduleId) {
  const result = await dynamo.send(new GetCommand({
    TableName: SCHEDULES_TABLE,
    Key: { userId, scheduleId },
  }));
  return result.Item;
}

/**
 * Advance the reported stage on an in-flight job.
 *
 * Deliberately best-effort: the job itself is what matters, and a failed
 * progress write must never abort work that has already cost a Bedrock call.
 * The frontend falls back to its elapsed-time estimate when the stage is
 * missing, so a dropped write degrades the display rather than breaking it.
 */
async function setProcessingStage(userId, scheduleId, stage) {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: SCHEDULES_TABLE,
      Key: { userId, scheduleId },
      UpdateExpression: "SET processingStage = :stage, updatedAt = :now",
      ExpressionAttributeValues: {
        ":stage": stage,
        ":now": new Date().toISOString(),
      },
    }));
  } catch (error) {
    console.error(`[${userId}] Could not record stage ${stage}:`, error.message);
  }
}

/**
 * Mark a job failed, carrying the stable error code so the frontend can show
 * copy specific to the failure rather than a generic message. Without the code
 * a polling client only learns *that* it failed, which is issue #5's
 * "failed jobs surface specific user-facing errors" requirement unmet.
 */
async function markScheduleFailed({ userId, scheduleId, message, code }) {
  if (!userId || !scheduleId) return;

  try {
    await dynamo.send(new UpdateCommand({
      TableName: SCHEDULES_TABLE,
      Key: { userId, scheduleId },
      UpdateExpression: [
        "SET #status = :failed",
        "#active = :false",
        "failureMessage = :message",
        "failureCode = :code",
        "updatedAt = :now",
      ].join(", "),
      ExpressionAttributeNames: {
        "#status": "processingStatus",
        "#active": "active",
      },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":false": false,
        ":message": message,
        ":code": code || "PROCESSING_FAILED",
        ":now": new Date().toISOString(),
      },
    }));
  } catch (error) {
    console.error(`[${userId}] Failed to mark schedule as failed:`, error.message);
  }
}

/**
 * Build the completed-job response body.
 *
 * Used by the API handler for an idempotent replay of an already-finished job.
 * The polling client reads the schedule record directly, and the frontend's
 * normalizePrescriptionResponse accepts either shape.
 */
function responseFromCompletedSchedule(schedule, headers, replay = false, confirmation = null) {
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
      // Whether a subscription confirmation email was queued (email method only).
      // `queued` reflects that the async send was accepted, not SES delivery —
      // the frontend offers a resend for the "queued but never arrived" case.
      ...(confirmation ? { confirmation } : {}),
      message: `Found ${medications.length} medication(s). ${scheduledDoses.length} dose reminder(s) scheduled.`,
    }),
  };
}

module.exports = {
  dynamo,
  STAGES,
  signSessionToken,
  ttlOneYear,
  shortHash,
  getIdempotencyKey,
  getExistingSchedule,
  setProcessingStage,
  markScheduleFailed,
  responseFromCompletedSchedule,
};
