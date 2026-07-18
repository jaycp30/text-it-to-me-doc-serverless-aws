/**
 * errors.js
 *
 * Frontend half of the error-code contract. The backend attaches a stable
 * `code` (see backend/functions/processPrescription/errors.js) to every failure;
 * here we map each code to user-facing copy with retry guidance that differs by
 * failure type, and classify client-only failures (timeout, network) that never
 * reach the backend.
 *
 * Pure module — no React, no DOM. Unit-tested in frontend/src/errors.test.js.
 */

/**
 * @typedef {Object} ErrorCopy
 * @property {string} title    short headline
 * @property {string} body     what happened
 * @property {string} retry    what the user should do next (varies by type)
 */

/** @type {Record<string, ErrorCopy>} */
export const ERROR_COPY = {
  MISSING_IMAGES: {
    title: "No pages came through",
    body: "It looks like no prescription image reached us.",
    retry: "Choose your prescription photos and try again.",
  },
  TOO_MANY_IMAGES: {
    title: "Too many pages",
    body: "You can upload up to 5 pages at once.",
    retry: "Remove some pages, then try again.",
  },
  MISSING_USER: {
    title: "Missing some details",
    body: "A required detail was missing from the request.",
    retry: "Go back, re-enter your details, and try again.",
  },
  MISSING_CONTACT: {
    title: "Missing contact details",
    body: "We need a phone number or email to send reminders to.",
    retry: "Go back and add your contact details, then try again.",
  },
  UNSUPPORTED_FILE: {
    title: "Unsupported file type",
    body: "That file isn't a supported image. We can read JPEG, PNG, or WebP.",
    retry: "Re-take the photo or export it as JPEG/PNG, then try again.",
  },
  IMAGE_UNREADABLE: {
    title: "Couldn't read that prescription",
    body: "The image may be too blurry or cropped, or it might not be a prescription.",
    retry: "Try a sharper, well-lit photo with the whole prescription in frame.",
  },
  SCHEDULE_CREATE_FAILED: {
    title: "Couldn't set up your reminders",
    body: "We read your prescription, but setting up the reminders didn't go through.",
    retry: "This is usually temporary — please try again in a moment.",
  },
  DUPLICATE_IN_PROGRESS: {
    title: "Already working on it",
    body: "This prescription is already being processed.",
    retry: "Please wait a few seconds — no need to re-upload. Then check your schedule.",
  },
  PREVIOUS_UPLOAD_FAILED: {
    title: "That upload didn't go through",
    body: "A previous attempt for these pages failed.",
    retry: "Choose your prescription pages again to start a fresh upload.",
  },
  INVALID_PAGE: {
    title: "A page looked off",
    body: "One of the pages couldn't be prepared for upload.",
    retry: "Try again with your prescription photos.",
  },
  UPLOAD_URL_FAILED: {
    title: "Couldn't start the upload",
    body: "We couldn't prepare the upload for your image.",
    retry: "Check your connection and try again.",
  },
  UPLOAD_FAILED: {
    title: "Upload failed",
    body: "One of your prescription images didn't finish uploading.",
    retry: "Check your connection and try again.",
  },
  TIMEOUT: {
    title: "This took too long",
    body: "Reading your prescription timed out. Larger or more complex prescriptions can take a while.",
    retry: "Try again, ideally with fewer pages.",
  },
  NETWORK_ERROR: {
    title: "Connection problem",
    body: "We couldn't reach the server.",
    retry: "Check your internet connection and try again.",
  },
  PROCESSING_FAILED: {
    title: "Something went wrong",
    body: "An unexpected error happened while processing your prescription.",
    retry: "Please try again. If it keeps happening, quote the reference below to support.",
  },
};

export const UNKNOWN_CODE = "UNKNOWN";

const UNKNOWN_COPY = {
  title: "Something went wrong",
  body: "An unexpected error happened.",
  retry: "Please try again. If it keeps happening, quote the reference below to support.",
};

/**
 * An API failure carrying the backend's stable code plus diagnostics.
 */
export class ApiError extends Error {
  /**
   * @param {string|undefined} code
   * @param {string|undefined} message
   * @param {{ status?: number, requestId?: string, detail?: string }} [meta]
   */
  constructor(code, message, { status, requestId, detail } = {}) {
    super(message || code || "Request failed");
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.detail = detail;
  }
}

/**
 * Map an HTTP status to a code when the body didn't carry one (older backends,
 * gateway-level errors, etc.).
 * @param {number|undefined} status
 * @returns {string}
 */
function codeFromStatus(status) {
  if (status === 504) return "TIMEOUT";
  if (status === 415) return "UNSUPPORTED_FILE";
  if (status === 502) return "SCHEDULE_CREATE_FAILED";
  return UNKNOWN_CODE;
}

/**
 * Classify a thrown error from the upload/process flow into a stable code plus
 * the diagnostics we want to show for support/log correlation.
 *
 * @param {unknown} err
 * @returns {{ code: string, requestId?: string, detail?: string }}
 */
export function classifyError(err) {
  // Client-only failures that never reached the backend.
  if (err && err.name === "AbortError") {
    return { code: "TIMEOUT" };
  }
  if (err instanceof TypeError) {
    // fetch() rejects with a TypeError on DNS/offline/CORS/connection failures.
    return { code: "NETWORK_ERROR" };
  }
  if (err instanceof ApiError) {
    const code = err.code && ERROR_COPY[err.code] ? err.code : codeFromStatus(err.status);
    return { code, requestId: err.requestId, detail: err.detail };
  }
  return { code: UNKNOWN_CODE, detail: err && err.message ? String(err.message) : undefined };
}

/**
 * Resolve display copy for a code, falling back to a safe generic message.
 * @param {string} code
 * @returns {ErrorCopy}
 */
export function resolveErrorCopy(code) {
  return ERROR_COPY[code] || UNKNOWN_COPY;
}
