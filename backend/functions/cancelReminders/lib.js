"use strict";

/**
 * lib.js
 *
 * Pure helpers extracted from cancelReminders/index.js for unit testing without
 * AWS. Covers session-token verification and the idempotent "count what was
 * cancelled" logic that makes a repeated unsubscribe safe.
 */

const { createHmac } = require("crypto");

/**
 * Verify an HMAC-signed session token of the form
 *   base64url(payload).base64url(HMAC-SHA256(secret, payload))
 * where payload is JSON `{ uid, exp }` (exp is a Unix timestamp in seconds).
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
 * records, skipping records/doses that never got a rule name.
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
 * Whether a single Promise.allSettled result for a DeleteSchedule call counts as
 * "handled". A rule that no longer exists (ResourceNotFoundException) is treated
 * as already-cancelled — this is what makes unsubscribe idempotent: firing it a
 * second time, or after a rule has auto-deleted on completion, still succeeds.
 *
 * @param {{ status: string, reason?: { name?: string } }} result
 */
function isCancelHandled(result) {
  if (result.status === "fulfilled") return true;
  return result.reason?.name === "ResourceNotFoundException";
}

/**
 * Count how many delete attempts were handled (real deletes + already-gone
 * rules). See isCancelHandled for the idempotency rationale.
 *
 * @param {Array<{ status: string, reason?: { name?: string } }>} results
 * @returns {number}
 */
function countCancelled(results) {
  return (results || []).reduce((count, result) => count + (isCancelHandled(result) ? 1 : 0), 0);
}

module.exports = {
  verifySessionToken,
  collectRuleNames,
  isCancelHandled,
  countCancelled,
};
