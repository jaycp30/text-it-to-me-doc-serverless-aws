"use strict";

/**
 * processPrescription/index.js
 *
 * The synchronous API handler behind POST /process. It does only the fast,
 * cheap work and hands the rest off:
 *   1. Validate the request (images, user, contact, Article 9 consent)
 *   2. Claim the idempotency lock, or replay an existing result
 *   3. Async-invoke worker.js
 *   4. Return 202 with the scheduleId the client polls on
 *
 * Why the split (issue #5): API Gateway caps a synchronous integration at 30
 * seconds, and Bedrock routinely needs 30–60s on a busy prescription. The old
 * single-call design therefore failed on exactly the prescriptions that
 * mattered most, and the function's own 120s timeout was unreachable. Moving
 * the slow work to an asynchronous invoke lifts that ceiling using Lambda's
 * ordinary 15-minute async limit.
 *
 * Everything here must stay fast. Nothing in this file should call Bedrock,
 * read S3, or create schedules.
 */

const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

// Pure request validation + scheduling logic lives in scheduling.js so it can
// be unit-tested without AWS. See backend/tests/scheduling.test.js.
const { validateImageKeys, validateConsent } = require("./scheduling");

// Stable error codes + response builder (see backend/tests/errors.test.js). The
// frontend maps these codes to user-facing copy in frontend/src/errors.js.
const { CODES, errorResponse } = require("./errors");

const {
  dynamo,
  signSessionToken,
  ttlOneYear,
  getIdempotencyKey,
  getExistingSchedule,
  markScheduleFailed,
  responseFromCompletedSchedule,
} = require("./shared");

const lambda = new LambdaClient({});

const { SCHEDULES_TABLE, WORKER_FUNCTION_ARN } = process.env;

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
      userId,            // pseudonymous browser-local id (localStorage UUID) — NOT an authenticated subject
      userTimezone,      // IANA timezone string e.g. "Asia/Manila"
      notificationMethod,// "sms" | "email"
      contactInfo,       // phone number (+63...) or email address
      consent,           // must be boolean true — explicit consent to process health data
      policyVersion,     // which privacy policy version that consent was given against
    } = body;

    // ── Validation ────────────────────────────────────────────────────────
    const { keys, error: imageKeysError } = validateImageKeys({ imageKey, imageKeys });
    if (imageKeysError) return errorResponse({ headers, requestId, ...imageKeysError });
    if (!userId)    return errorResponse({ headers, requestId, statusCode: 400, code: CODES.MISSING_USER, message: "userId is required" });
    if (!contactInfo) return errorResponse({ headers, requestId, statusCode: 400, code: CODES.MISSING_CONTACT, message: "contactInfo (phone or email) is required" });

    // Explicit consent is checked before anything is read, stored or charged:
    // without it there is no lawful basis to process an Article 9 health record
    // at all, so no image should be fetched and no Bedrock call should be made.
    const { consentAt, policyVersion: consentedPolicyVersion, error: consentError } =
      validateConsent({ consent, policyVersion });
    if (consentError) return errorResponse({ headers, requestId, ...consentError });

    const timezone = userTimezone || "Asia/Manila";
    const idempotencyKey = getIdempotencyKey({ uploadId, keys, userId });
    const prescriptionId = `rx-${idempotencyKey}`;
    const scheduleId = `sched-${idempotencyKey}`;
    const now = new Date().toISOString();
    const expiresAt = ttlOneYear();

    // Acquire an idempotency lock before handing off. A duplicate request with
    // the same uploadId must not start a second worker and pay for Bedrock
    // twice. The item written here is also the worker's input: it re-reads
    // these fields rather than receiving contact details in a payload.
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
          consentAt,
          policyVersion: consentedPolicyVersion,
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

      // Still processing — hand the client the same job to poll rather than
      // starting a second one.
      return accepted({ headers, userId, scheduleId, prescriptionId, duplicate: true });
    }

    // ── Hand off to the worker ────────────────────────────────────────────
    // "Event" = asynchronous: Lambda returns as soon as the request is queued,
    // so this handler stays well inside API Gateway's 30s ceiling regardless
    // of how long the prescription takes to read.
    await lambda.send(new InvokeCommand({
      FunctionName: WORKER_FUNCTION_ARN,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ userId, scheduleId })),
    }));
    console.log(`[${userId}] Queued worker for ${scheduleId}`);

    return accepted({ headers, userId, scheduleId, prescriptionId });

  } catch (error) {
    console.error("Unhandled error:", error);

    // If the lock was claimed, release it as failed — otherwise the record sits
    // in "processing" forever and blocks the user from retrying these images.
    if (lockedSchedule) {
      await markScheduleFailed({
        ...lockedSchedule,
        message: error.message,
        code: CODES.PROCESSING_FAILED,
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

/**
 * 202 Accepted — the job is queued, not done.
 *
 * `sessionToken` is issued here rather than on completion so the client can
 * start polling GET /schedules immediately. It only encodes the userId, so
 * nothing about it needs the job to have finished.
 */
function accepted({ headers, userId, scheduleId, prescriptionId, duplicate = false }) {
  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({
      status: "processing",
      scheduleId,
      prescriptionId,
      sessionToken: signSessionToken(userId),
      // True when this request joined a job that was already running, rather
      // than starting one. The client polls identically either way.
      ...(duplicate ? { duplicate: true } : {}),
      message: "Reading your prescription. This usually takes under a minute.",
    }),
  };
}
