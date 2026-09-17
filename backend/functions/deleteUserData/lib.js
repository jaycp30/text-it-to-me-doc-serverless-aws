"use strict";

/**
 * lib.js
 *
 * Pure helpers extracted from deleteUserData/index.js so the batching and
 * counting logic can be unit-tested without AWS. Mirrors the split already used
 * by cancelReminders — see backend/tests/deleteUserData.test.js.
 */

const { createHmac } = require("crypto");

/**
 * Verify an HMAC-signed session token. Erasure accepts the same token as
 * cancellation, so this is byte-for-byte the logic in cancelReminders/lib.js.
 *
 * It is COPIED rather than imported, and that is a deployment constraint, not a
 * preference: SAM packages each function's CodeUri directory on its own, so a
 * `require("../cancelReminders/lib")` resolves fine locally, builds green, and
 * then throws "Cannot find module" on the first real invocation in Lambda.
 *
 * The copy is guarded mechanically — backend/tests/deleteUserData.test.js runs
 * both implementations over the same cases and fails if they ever disagree. If a
 * third function needs this, stop copying and move it into a Lambda layer.
 *
 * @param {string} token
 * @param {string} secret        the MagicLink signing secret
 * @param {number} [nowSeconds]  current time in Unix seconds (injectable for tests)
 * @returns {string|null}        the user id if valid and unexpired, else null
 */
function verifySessionToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig !== expected) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.uid || !data.exp) return null;
    if (nowSeconds > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

/**
 * Collect every EventBridge Scheduler rule name across a user's schedule
 * records. Same reasoning as verifySessionToken above — copied because the
 * function packages alone, and covered by the same equivalence test.
 *
 * @param {Array<{ scheduledDoses?: Array<{ scheduleName?: string }> }>} schedules
 * @returns {string[]}
 */
function collectRuleNames(schedules) {
  return (schedules || []).flatMap((schedule) =>
    (schedule.scheduledDoses || [])
      .map((dose) => dose.scheduleName)
      .filter(Boolean)
  );
}

/**
 * Sanitise one S3 key segment.
 *
 * Copied byte-for-byte from getUploadUrl/index.js, which applies it to `userId`
 * before building the object key. Erasure MUST apply exactly the same transform,
 * or it lists a prefix the images were never written under: it would then delete
 * nothing and cheerfully report success, which is the precise failure this whole
 * endpoint exists to eliminate. For a plain UUID the two are identical — the
 * divergence only appears for an id containing characters this rewrites, and the
 * userId format is not validated at the point it is accepted.
 *
 * Copied rather than imported for the same packaging reason as
 * verifySessionToken above, and pinned by tests in deleteUserData.test.js.
 *
 * @param {string} value
 * @returns {string}
 */
function safeSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 120);
}

/**
 * The S3 prefix holding every prescription image for a user.
 *
 * getUploadUrl writes keys as
 * `${safeSegment(userId)}/prescriptions/${uploadId}/page-N.ext`, so this prefix
 * covers all of them. The trailing slash matters: without it, `abc/` would also
 * match a hypothetical `abcd/`, and erasure would delete another user's images.
 *
 * @param {string} userId
 * @returns {string}
 */
function imagePrefixFor(userId) {
  return `${safeSegment(userId)}/prescriptions/`;
}

/**
 * Split a list into fixed-size chunks.
 *
 * Both AWS batch APIs this function calls have hard per-request caps that are
 * rejections, not throttles: DeleteObjects takes at most 1000 keys and
 * BatchWriteItem at most 25 requests. Exceeding either fails the whole call.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  if (!Array.isArray(items) || size < 1) return [];
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Build the DeleteRequest entries for one DynamoDB table from queried items.
 *
 * @param {Array<Record<string, any>>} items  items returned by a Query
 * @param {string[]} keyNames                 the table's key attribute names
 * @returns {Array<{ DeleteRequest: { Key: Record<string, any> } }>}
 */
function toDeleteRequests(items, keyNames) {
  return (items || [])
    .filter((item) => keyNames.every((name) => item?.[name] !== undefined))
    .map((item) => ({
      DeleteRequest: {
        Key: Object.fromEntries(keyNames.map((name) => [name, item[name]])),
      },
    }));
}

/**
 * Whether a single Promise.allSettled result for a DeleteSchedule call counts as
 * handled. A rule that has already fired and auto-deleted comes back as
 * ResourceNotFoundException, which is success for our purposes — the rule is
 * gone, which is all erasure needs.
 *
 * Same rule as cancelReminders.isCancelHandled, restated here because erasure
 * must stay correct even if the cancel path's idempotency policy ever changes.
 *
 * @param {{ status: string, reason?: { name?: string } }} result
 * @returns {boolean}
 */
function isDeleteHandled(result) {
  if (result?.status === "fulfilled") return true;
  return result?.reason?.name === "ResourceNotFoundException";
}

/**
 * Collect the reasons from settled calls that genuinely failed, so the handler
 * can decide whether the erasure was complete.
 *
 * This is the piece that makes the response honest. Promise.allSettled never
 * throws, so without inspecting the rejections a half-failed erasure would
 * return a cheerful 200 and the user would believe their data was gone.
 *
 * @param {Array<{ status: string, reason?: { name?: string, message?: string } }>} results
 * @returns {string[]} messages for the failures that are not "already gone"
 */
function collectFailures(results) {
  return (results || [])
    .filter((result) => !isDeleteHandled(result))
    .map((result) => result?.reason?.message || "unknown error");
}

module.exports = {
  verifySessionToken,
  collectRuleNames,
  safeSegment,
  imagePrefixFor,
  chunk,
  toDeleteRequests,
  isDeleteHandled,
  collectFailures,
};
