"use strict";

/**
 * lib.js
 *
 * Pure helpers extracted from cancelReminders/index.js for unit testing without
 * AWS. Covers the idempotent "count what was cancelled" logic that makes a
 * repeated unsubscribe safe.
 *
 * Session-token verification used to live here too. It now lives in the auth
 * layer (backend/layers/auth/nodejs/node_modules/rx-session-token/) so there is one
 * copy of it across all the functions that need it.
 */

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
  collectRuleNames,
  isCancelHandled,
  countCancelled,
};
