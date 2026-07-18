"use strict";

/**
 * errors.js
 *
 * Stable, machine-readable error codes for the /process endpoint, plus small
 * helpers to build consistent error responses. The frontend maps these codes to
 * user-facing copy and retry guidance (see frontend/src/errors.js), so the
 * string values are a contract — change them deliberately, never casually.
 *
 * Pure module: no AWS, no I/O. Unit-tested in backend/tests/errors.test.js.
 */

// Frozen so a typo like CODES.TOO_MANY_IMAGE throws instead of silently
// producing an undefined code that the frontend can't map.
const CODES = Object.freeze({
  MISSING_IMAGES:        "MISSING_IMAGES",        // no imageKey/imageKeys supplied
  TOO_MANY_IMAGES:       "TOO_MANY_IMAGES",       // more than MAX_IMAGES
  MISSING_USER:          "MISSING_USER",          // no userId
  MISSING_CONTACT:       "MISSING_CONTACT",       // no phone/email
  UNSUPPORTED_FILE:      "UNSUPPORTED_FILE",      // not JPEG/PNG/WebP
  IMAGE_UNREADABLE:      "IMAGE_UNREADABLE",      // Bedrock output unparseable (blurry or not a prescription)
  SCHEDULE_CREATE_FAILED:"SCHEDULE_CREATE_FAILED",// parsed OK but no reminder could be created
  DUPLICATE_IN_PROGRESS: "DUPLICATE_IN_PROGRESS", // same upload already processing
  PREVIOUS_UPLOAD_FAILED:"PREVIOUS_UPLOAD_FAILED",// same upload previously failed
  PROCESSING_FAILED:     "PROCESSING_FAILED",     // unexpected/unclassified server error
});

/**
 * A processing error that carries an HTTP status, a stable code, and optional
 * safe diagnostic detail. Throw it from deep helpers (e.g. image fetch) and let
 * the handler translate it into a response.
 */
class ProcessingError extends Error {
  /**
   * @param {string} code       one of CODES
   * @param {number} statusCode HTTP status
   * @param {string} message    user-safe message
   * @param {string} [detail]   safe diagnostic detail (no PII/secrets)
   */
  constructor(code, statusCode, message, detail) {
    super(message);
    this.name = "ProcessingError";
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/**
 * Build an API Gateway Lambda-proxy error response with a consistent body:
 *   { error, code, detail?, requestId? }
 *
 * @param {object} params
 * @param {object} params.headers      response headers (CORS etc.)
 * @param {number} params.statusCode
 * @param {string} params.code         one of CODES
 * @param {string} params.message      user-facing message
 * @param {string} [params.detail]     safe diagnostic detail
 * @param {string} [params.requestId]  Lambda awsRequestId for log correlation
 */
function errorResponse({ headers, statusCode, code, message, detail, requestId }) {
  const body = { error: message, code };
  if (detail) body.detail = detail;
  if (requestId) body.requestId = requestId;
  return { statusCode, headers, body: JSON.stringify(body) };
}

module.exports = {
  CODES,
  ProcessingError,
  errorResponse,
};
