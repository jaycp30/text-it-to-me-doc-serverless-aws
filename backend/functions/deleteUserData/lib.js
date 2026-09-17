"use strict";

/**
 * lib.js
 *
 * Pure helpers extracted from deleteUserData/index.js so the batching and
 * counting logic can be unit-tested without AWS. Mirrors the split already used
 * by cancelReminders — see backend/tests/deleteUserData.test.js.
 */

/**
 * Collect every EventBridge Scheduler rule name across a user's schedule
 * records.
 *
 * Still a copy of cancelReminders/lib.js, because SAM packages each function's
 * CodeUri alone. It stays a copy rather than moving to the auth layer: that
 * layer holds the session-token primitive, and this is scheduling domain logic
 * that has no business living there. The equivalence test in
 * backend/tests/deleteUserData.test.js fails if the two ever diverge.
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
 * The S3 prefix holding every prescription image for a user.
 *
 * getUploadUrl writes keys as `${userId}/prescriptions/${uploadId}/page-N.ext`
 * with the RAW userId — deliberately, because every id the system accepts has
 * already passed USER_ID_PATTERN at the auth boundary and is therefore safe as a
 * key segment. This function must interpolate it the same way. Sanitising here
 * (or there, but not both) is precisely the write-vs-search drift that makes an
 * erasure delete nothing and report success.
 *
 * The trailing slash matters too: without it, `abc/` would also match a
 * hypothetical `abcd/`, and erasure would delete another user's images.
 *
 * @param {string} userId  a verified, USER_ID_PATTERN-shaped id
 * @returns {string}
 */
function imagePrefixFor(userId) {
  return `${userId}/prescriptions/`;
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
  collectRuleNames,
  imagePrefixFor,
  chunk,
  toDeleteRequests,
  isDeleteHandled,
  collectFailures,
};
