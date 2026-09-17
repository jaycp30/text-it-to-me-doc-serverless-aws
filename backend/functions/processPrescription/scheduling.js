"use strict";

/**
 * scheduling.js
 *
 * Pure scheduling logic extracted from processPrescription/index.js so it can be
 * unit-tested without any AWS calls. The handler (index.js) is the only caller;
 * it wires these functions to Bedrock, DynamoDB, S3 and EventBridge Scheduler.
 *
 * Nothing in this file touches AWS, the network, or process state — every
 * function is deterministic given its inputs (time is read via luxon, which the
 * tests freeze with `Settings.now`).
 */

const { DateTime } = require("luxon");
const { randomUUID } = require("crypto");

const MAX_IMAGES = 5;

// Recurring / maintenance meds come back from Bedrock with date: null and only
// a time-of-day. We expand each into one dated dose per day across a window.
const DEFAULT_RECURRING_DAYS = 30;    // horizon for open-ended meds (no end_date/duration)
const MAX_OCCURRENCES_PER_DOSE = 60;  // safety cap on EventBridge rules per dose entry

// EventBridge Scheduler "Name" must match [a-zA-Z0-9-_.], be unique within the
// group, and be <= 64 characters (NOT 512).
const SCHEDULE_NAME_MAX_LENGTH = 64;

/**
 * Validate the image keys coming from the request body.
 *
 * Accepts either the legacy single `imageKey` or the multi-page `imageKeys`
 * array, and enforces the MAX_IMAGES ceiling.
 *
 * The error carries a stable `code` (kept in sync with processPrescription/errors.js
 * without importing it, to avoid coupling this pure module to the error catalog).
 *
 * @param {{ imageKey?: string, imageKeys?: string[] }} body
 * @returns {{ keys: string[], error: { statusCode: number, code: string, message: string } | null }}
 */
function validateImageKeys({ imageKey, imageKeys } = {}) {
  const keys = Array.isArray(imageKeys) ? imageKeys : imageKey ? [imageKey] : [];

  if (!keys.length) {
    return {
      keys,
      error: { statusCode: 400, code: "MISSING_IMAGES", message: "imageKey or imageKeys is required" },
    };
  }
  if (keys.length > MAX_IMAGES) {
    return {
      keys,
      error: {
        statusCode: 400,
        code: "TOO_MANY_IMAGES",
        message: `A maximum of ${MAX_IMAGES} images can be processed at once`,
      },
    };
  }
  return { keys, error: null };
}

/**
 * Validate that every image key belongs to the caller's own S3 prefix.
 *
 * validateImageKeys above only counts keys — it never checked whose they were.
 * That gap meant a caller with a completely legitimate identity of their own
 * could pass `<someone-else>/prescriptions/<uploadId>/page-1.jpg` and have the
 * worker fetch, OCR and store that person's prescription into the caller's
 * partition. Authenticating the caller does not fix it; the keys have to be
 * checked against *whose* they are.
 *
 * `userId` must already be a verified, USER_ID_PATTERN-shaped id (it comes from
 * verifySessionToken), which is what makes this prefix byte-identical to the one
 * getUploadUrl writes under.
 *
 * @param {string[]} keys
 * @param {string} userId  the verified caller
 * @returns {{ error: { statusCode: number, code: string, message: string } | null }}
 */
function validateKeyOwnership(keys, userId) {
  // userId is interpolated into a regex below, so its shape is asserted first.
  // verifySessionToken already guarantees it, but a pure module should not
  // depend on a caller's guarantee to stay injection-free.
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(userId || ""))) {
    return {
      error: {
        statusCode: 403,
        code: "FOREIGN_IMAGE_KEYS",
        message: "Those uploads do not belong to this session.",
      },
    };
  }

  // Matched exactly, not by prefix. A startsWith check accepts
  // `<uid>/prescriptions/../../<victim>/prescriptions/page-1.jpg`, which is
  // only harmless because S3 treats keys as opaque strings and does not
  // normalise dot segments. Cross-tenant access to health data should not rest
  // on that being true of whichever SDK signs the request next year. We control
  // the entire key shape, so we can simply require it.
  const shape = new RegExp(
    `^${userId}/prescriptions/[A-Za-z0-9_-]{1,120}/page-[1-5]\\.(jpg|png|webp)$`,
  );
  const foreign = (keys || []).filter((key) => !shape.test(String(key)));

  if (foreign.length > 0) {
    return {
      error: {
        statusCode: 403,
        code: "FOREIGN_IMAGE_KEYS",
        message: "Those uploads do not belong to this session.",
      },
    };
  }

  return { error: null };
}

/**
 * Validate the explicit consent flag coming from the request body.
 *
 * A prescription image, and the medication data extracted from it, is GDPR
 * Article 9 "special category" health data. Article 9 processing is prohibited
 * by default; the exemption this app relies on is 9(2)(a), explicit consent.
 * That is a higher bar than ordinary consent — it must be an affirmative act,
 * specific to this processing, and *demonstrable* (Art. 7(1)).
 *
 * "Demonstrable" is why this lives on the server. The Read button is disabled
 * until the box is ticked, but that is a UX affordance: a direct POST to
 * /process bypasses the UI entirely. The server is the only place consent can
 * actually be enforced, and the returned consentAt is the record that evidences
 * it.
 *
 * Strict `=== true` on purpose. A truthy value like the string "false", 1, or
 * "yes" must not satisfy something that has to be a deliberate affirmative act.
 *
 * policyVersion is required alongside it so the record says *what* was agreed
 * to. This adds no compatibility risk: any client sending `consent` is a client
 * new enough to send the version too, and an older cached client sends neither
 * and is rejected on the first check — which is the intended behaviour.
 *
 * The error carries a stable `code` (kept in sync with processPrescription/errors.js
 * without importing it, to avoid coupling this pure module to the error catalog).
 *
 * @param {{ consent?: unknown, policyVersion?: unknown }} body
 * @returns {{ consentAt: string | null, policyVersion: string | null, error: { statusCode: number, code: string, message: string, detail?: string } | null }}
 */
function validateConsent({ consent, policyVersion } = {}) {
  if (consent !== true) {
    return {
      consentAt: null,
      policyVersion: null,
      error: {
        statusCode: 400,
        code: "CONSENT_REQUIRED",
        message: "We need your permission to read your prescription before we can continue.",
        detail: "consent must be boolean true",
      },
    };
  }

  if (typeof policyVersion !== "string" || !policyVersion.trim()) {
    return {
      consentAt: null,
      policyVersion: null,
      error: {
        statusCode: 400,
        code: "CONSENT_REQUIRED",
        message: "We need your permission to read your prescription before we can continue.",
        detail: "policyVersion is required alongside consent",
      },
    };
  }

  return {
    consentAt: new Date().toISOString(),
    policyVersion: policyVersion.trim(),
    error: null,
  };
}

/**
 * Expand a single dose entry into one or more DATED dose objects.
 *
 * - A dose that already has a `date` (taper / fixed-with-date) is returned as-is.
 * - A date-less dose (recurring / maintenance med, e.g. "1 capsule once daily")
 *   is expanded into one dated dose per day across a window:
 *     start = later of (prescription date, today)   — never schedule the past
 *     end   = med.end_date, else prescriptionDate + duration_days,
 *             else today + DEFAULT_RECURRING_DAYS    — open-ended maintenance
 *   capped at MAX_OCCURRENCES_PER_DOSE to bound the number of EventBridge rules.
 *
 * @returns {Array<object>} zero or more dated dose objects
 */
function expandDoseToDates({ med, dose, prescriptionDate, timezone }) {
  if (dose.date) return [dose];          // already dated — taper/fixed
  if (!dose.time) return [];             // no time either — cannot schedule

  const today  = DateTime.now().setZone(timezone).startOf("day");
  const rxStart = prescriptionDate
    ? DateTime.fromISO(prescriptionDate, { zone: timezone }).startOf("day")
    : today;

  // Never generate past dates — start from the later of rx date and today.
  const start = rxStart > today ? rxStart : today;

  // Determine the end of the window.
  let end;
  if (med.end_date) {
    end = DateTime.fromISO(med.end_date, { zone: timezone }).startOf("day");
  } else if (med.duration_days) {
    end = rxStart.plus({ days: med.duration_days - 1 });
  } else {
    end = today.plus({ days: DEFAULT_RECURRING_DAYS });
  }

  if (!end.isValid || end < start) return [];

  const dates = [];
  let cursor = start;
  while (cursor <= end && dates.length < MAX_OCCURRENCES_PER_DOSE) {
    dates.push({ ...dose, date: cursor.toISODate() });
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

/**
 * Flatten a parsed prescription into the list of dated doses that should get an
 * EventBridge rule, plus the doses that were skipped.
 *
 * Scheduling rules:
 *  - PRN medications (`schedule_type === "prn"`) are skipped entirely.
 *  - Individual `as_needed` doses are skipped.
 *  - Recurring/date-less doses are expanded via expandDoseToDates; a dose that
 *    expands to nothing (no schedulable date/time) is recorded as skipped.
 *
 * @param {object} prescription  parsed Bedrock output
 * @param {string} timezone      IANA timezone
 * @returns {{ dosesToSchedule: object[], skippedDoses: object[] }}
 */
function buildDosesToSchedule(prescription, timezone) {
  const dosesToSchedule = [];
  const skippedDoses = [];

  for (const med of prescription.medications || []) {
    // Skip PRN (as needed) — these have no fixed schedule.
    if (med.schedule_type === "prn") continue;

    for (const dose of med.doses || []) {
      if (dose.as_needed) continue;

      const datedDoses = expandDoseToDates({
        med,
        dose,
        prescriptionDate: prescription.prescription_date,
        timezone,
      });

      if (datedDoses.length === 0) {
        skippedDoses.push({ medication: med.name, ...dose });
        continue;
      }

      for (const datedDose of datedDoses) {
        dosesToSchedule.push({
          medication: med.name,
          brand: med.brand,
          form: med.form,
          dose_mg: med.dose_mg,
          special_instructions: med.special_instructions,
          ...datedDose,
        });
      }
    }
  }

  return { dosesToSchedule, skippedDoses };
}

/**
 * Convert a dated dose (local date + time in the user's timezone) to a UTC
 * DateTime. Returns an invalid DateTime if the dose has no date/time.
 */
function doseToUtc(dose, timezone) {
  if (!dose.date || !dose.time) return DateTime.invalid("missing date or time");
  return DateTime.fromISO(`${dose.date}T${dose.time}`, { zone: timezone }).toUTC();
}

/**
 * Whether a dose's scheduled moment is already in the past. Doses in the past
 * must not get an EventBridge rule.
 *
 * @param {object} dose
 * @param {string} timezone
 * @param {DateTime} [now]  defaults to the current UTC time
 */
function isDosePast(dose, timezone, now = DateTime.utc()) {
  const utcDT = doseToUtc(dose, timezone);
  if (!utcDT.isValid) return true; // unschedulable → treated as skip
  return utcDT < now;
}

/**
 * Build a collision-proof EventBridge Scheduler rule name for a dose.
 *
 * The name is a truncated medication slug plus a random 8-char suffix, and is
 * hard-capped at SCHEDULE_NAME_MAX_LENGTH (64) characters using only the
 * characters EventBridge allows: [a-zA-Z0-9-_].
 *
 * @param {{ date: string, time: string, medication?: string }} dose
 * @param {string} [unique]  8-char uniqueness suffix (injectable for tests)
 */
function buildScheduleName(dose, unique = randomUUID().slice(0, 8)) {
  const medSlug = (dose.medication || "med")
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 18);
  return `rx-${dose.date}-${String(dose.time).replace(":", "")}-${medSlug}-${unique}`
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .substring(0, SCHEDULE_NAME_MAX_LENGTH);
}

/**
 * Whether reminder creation failed completely: there were doses to schedule, none
 * succeeded, and at least one failed due to a creation *error* (not a past-dose
 * skip). This is the case that should surface SCHEDULE_CREATE_FAILED rather than
 * a misleading "0 reminders scheduled" success.
 *
 * @param {number} attempted       count of doses we tried to schedule
 * @param {number} scheduled       count that succeeded
 * @param {number} creationErrors  count that threw during creation
 */
function isTotalScheduleFailure(attempted, scheduled, creationErrors) {
  return attempted > 0 && scheduled === 0 && creationErrors > 0;
}

module.exports = {
  MAX_IMAGES,
  DEFAULT_RECURRING_DAYS,
  MAX_OCCURRENCES_PER_DOSE,
  SCHEDULE_NAME_MAX_LENGTH,
  validateImageKeys,
  validateKeyOwnership,
  validateConsent,
  expandDoseToDates,
  buildDosesToSchedule,
  doseToUtc,
  isDosePast,
  buildScheduleName,
  isTotalScheduleFailure,
};
