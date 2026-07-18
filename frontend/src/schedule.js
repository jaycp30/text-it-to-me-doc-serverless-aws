/**
 * schedule.js
 *
 * Pure helpers for the schedule-management view (issue #9): derive a schedule
 * record's status, pick the one to display from GET /schedules, and normalize it
 * into display fields. No React, no DOM — unit-tested in schedule.test.js.
 */

export const SCHEDULE_STATUS = {
  ACTIVE: "active",
  CANCELLED: "cancelled",
  PROCESSING: "processing",
  FAILED: "failed",
  INACTIVE: "inactive",
};

/**
 * Derive a display status from a schedule record's `active` flag and
 * `processingStatus`. Cancelled wins over inactive so a cancelled schedule
 * reads clearly (AC: cancelled/inactive distinguished from active).
 *
 * @param {object|null|undefined} schedule
 * @returns {string} one of SCHEDULE_STATUS
 */
export function scheduleStatus(schedule) {
  if (!schedule) return SCHEDULE_STATUS.INACTIVE;
  const ps = schedule.processingStatus;
  if (ps === "cancelled" || (schedule.active === false && schedule.cancelledAt)) {
    return SCHEDULE_STATUS.CANCELLED;
  }
  if (ps === "processing") return SCHEDULE_STATUS.PROCESSING;
  if (ps === "failed") return SCHEDULE_STATUS.FAILED;
  if (schedule.active === true) return SCHEDULE_STATUS.ACTIVE;
  return SCHEDULE_STATUS.INACTIVE;
}

/** Most-recent-first comparator by updatedAt (falling back to createdAt). */
function byRecencyDesc(a, b) {
  return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
}

/**
 * From the list returned by GET /schedules, pick the single schedule to show:
 * the most recently updated ACTIVE one, else the most recent of any status.
 *
 * @param {Array<object>|null|undefined} schedules
 * @returns {object|null}
 */
export function pickCurrentSchedule(schedules) {
  const list = (Array.isArray(schedules) ? schedules : []).filter(Boolean);
  if (list.length === 0) return null;

  const active = list
    .filter((s) => scheduleStatus(s) === SCHEDULE_STATUS.ACTIVE)
    .sort(byRecencyDesc);
  if (active.length) return active[0];

  return [...list].sort(byRecencyDesc)[0];
}

/**
 * Normalize a schedule record into the fields the management card displays.
 *
 * @param {object|null|undefined} schedule
 * @returns {null | {
 *   status: string, createdAt: string|null, updatedAt: string|null,
 *   cancelledAt: string|null, channel: string, contact: string,
 *   timezone: string, doseCount: number, medCount: number
 * }}
 */
export function summarizeSchedule(schedule) {
  if (!schedule) return null;
  const meds = schedule.medications || schedule.prescription?.medications || [];
  return {
    status: scheduleStatus(schedule),
    createdAt: schedule.createdAt || null,
    updatedAt: schedule.updatedAt || null,
    cancelledAt: schedule.cancelledAt || null,
    channel: schedule.notificationMethod || "sms",
    contact: schedule.contactInfo || "",
    timezone: schedule.userTimezone || "",
    doseCount: (schedule.scheduledDoses || []).length,
    medCount: meds.length,
  };
}
