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
const { validateImageKeys, validateKeyOwnership, validateConsent } = require("./scheduling");
// One implementation of the auth primitive, shipped as a layer. See
// backend/layers/auth/nodejs/node_modules/rx-session-token/.
const { verifySessionToken } = require("rx-session-token");

// Stable error codes + response builder (see backend/tests/errors.test.js). The
// frontend maps these codes to user-facing copy in frontend/src/errors.js.
const { CODES, errorResponse } = require("./errors");

const {
  dynamo,
  ttlOneYear,
  getIdempotencyKey,
  getExistingSchedule,
  markScheduleFailed,
  responseFromCompletedSchedule,
} = require("./shared");

const lambda = new LambdaClient({});

const { SCHEDULES_TABLE, WORKER_FUNCTION_ARN } = process.env;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

// Scoped to the app origin rather than "*". The HttpApi's own CorsConfiguration
// is already locked to AppUrl, but these per-response headers are what a browser
// actually reads, so a wildcard here quietly widens what the template claims.
//
// Omitted entirely when APP_URL is unset rather than sent as "null": "null" is a
// real origin a browser will match (sandboxed iframes, some redirect and data:
// contexts), so it fails open where omitting fails closed.
const APP_URL = process.env.APP_URL || "";

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    ...(APP_URL ? { "Access-Control-Allow-Origin": APP_URL } : {}),
  };

  // Surfaced in error responses so a user can quote it to support and we can
  // grep the exact invocation in CloudWatch.
  const requestId = context?.awsRequestId;

  let lockedSchedule = null;

  // Parsed BEFORE the main try. Inside it, a malformed body throws into the
  // catch-all at the bottom and surfaces as a 500 -- telling the caller the
  // server broke when in fact their request did, and counting as a genuine
  // Lambda error in the metrics #12 wants to alarm on.
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse({
      headers, requestId, statusCode: 400, code: CODES.MALFORMED_JSON,
      message: "Request body is not valid JSON.",
    });
  }

  try {
    const {
      imageKey,          // S3 key of the uploaded prescription image (legacy single-image path)
      imageKeys,         // S3 keys of uploaded prescription images (multi-page path)
      uploadId,          // shared S3 prefix segment for one prescription upload
      sessionToken,      // signed token from POST /upload-url — the ONLY source of identity
      userTimezone,      // IANA timezone string e.g. "Asia/Manila"
      notificationMethod,// "sms" | "email"
      contactInfo,       // phone number (+63...) or email address
      consent,           // must be boolean true — explicit consent to process health data
      policyVersion,     // which privacy policy version that consent was given against
    } = body;

    // ── Validation ────────────────────────────────────────────────────────
    // Identity comes from the signed token and nowhere else. This endpoint used
    // to take a userId from the body and then SIGN A TOKEN FOR IT, which let
    // anyone who knew another user's id impersonate them outright.
    const userId = verifySessionToken(sessionToken, MAGIC_LINK_SECRET);
    if (!userId) {
      return errorResponse({
        headers, requestId, statusCode: 401, code: CODES.INVALID_SESSION,
        message: "Invalid or expired session. Start a new upload.",
      });
    }

    const { keys, error: imageKeysError } = validateImageKeys({ imageKey, imageKeys });
    if (imageKeysError) return errorResponse({ headers, requestId, ...imageKeysError });

    // The keys must be the caller's own. Without this, a user with a perfectly
    // valid identity of their own could pass someone else's key and have the
    // worker read, OCR and store that prescription into their partition.
    // Matched against the exact key shape getUploadUrl writes, not by prefix.
    const { error: ownershipError } = validateKeyOwnership(keys, userId);
    if (ownershipError) return errorResponse({ headers, requestId, ...ownershipError });

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
      return accepted({ headers, scheduleId, prescriptionId, duplicate: true });
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

    return accepted({ headers, scheduleId, prescriptionId });

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
 * No session token is returned. The client already holds one from
 * POST /upload-url, which is now the only place an identity is minted.
 */
function accepted({ headers, scheduleId, prescriptionId, duplicate = false }) {
  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({
      status: "processing",
      scheduleId,
      prescriptionId,
      // True when this request joined a job that was already running, rather
      // than starting one. The client polls identically either way.
      ...(duplicate ? { duplicate: true } : {}),
      message: "Reading your prescription. This usually takes under a minute.",
    }),
  };
}
