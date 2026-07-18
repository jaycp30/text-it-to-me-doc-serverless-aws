import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { DateTime } from "luxon";

import {
  MAX_IMAGES,
  MAX_OCCURRENCES_PER_DOSE,
  DEFAULT_RECURRING_DAYS,
  SCHEDULE_NAME_MAX_LENGTH,
  validateImageKeys,
  expandDoseToDates,
  buildDosesToSchedule,
  isDosePast,
  buildScheduleName,
  isTotalScheduleFailure,
} from "../functions/processPrescription/scheduling.js";

// All time-dependent behavior is pinned to a fixed "now" so the tests are
// deterministic. Asia/Manila (UTC+8, no DST) keeps the arithmetic simple.
// 2026-07-18T12:00 Manila == 2026-07-18T04:00Z.
//
// We freeze via vi.setSystemTime (which patches the global Date that luxon's
// default clock reads) rather than luxon's Settings.now — under Vitest the test
// and scheduling.js can resolve to separate luxon module copies, so a
// Settings.now set here would not reach the code under test.
const TZ = "Asia/Manila";
const FROZEN_NOW = DateTime.fromISO("2026-07-18T12:00:00", { zone: TZ });
const TODAY = "2026-07-18";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW.toJSDate());
});

afterAll(() => {
  vi.useRealTimers();
});

describe("validateImageKeys — max image validation", () => {
  it("rejects a request with no image keys", () => {
    const { keys, error } = validateImageKeys({});
    expect(keys).toEqual([]);
    expect(error).toEqual({ statusCode: 400, code: "MISSING_IMAGES", message: "imageKey or imageKeys is required" });
  });

  it("rejects more than MAX_IMAGES keys", () => {
    const tooMany = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `img-${i}.jpg`);
    const { error } = validateImageKeys({ imageKeys: tooMany });
    expect(error).toEqual({
      statusCode: 400,
      code: "TOO_MANY_IMAGES",
      message: `A maximum of ${MAX_IMAGES} images can be processed at once`,
    });
  });

  it("accepts exactly MAX_IMAGES keys", () => {
    const exact = Array.from({ length: MAX_IMAGES }, (_, i) => `img-${i}.jpg`);
    const { keys, error } = validateImageKeys({ imageKeys: exact });
    expect(error).toBeNull();
    expect(keys).toHaveLength(MAX_IMAGES);
  });

  it("accepts the legacy single imageKey", () => {
    const { keys, error } = validateImageKeys({ imageKey: "one.png" });
    expect(error).toBeNull();
    expect(keys).toEqual(["one.png"]);
  });

  it("prefers imageKeys over a stray imageKey when both are present", () => {
    const { keys } = validateImageKeys({ imageKey: "legacy.png", imageKeys: ["a.png", "b.png"] });
    expect(keys).toEqual(["a.png", "b.png"]);
  });
});

describe("expandDoseToDates — recurring expansion & past-date skip", () => {
  it("returns an already-dated dose unchanged (taper / fixed)", () => {
    const dose = { date: "2026-08-01", time: "08:00", amount: 1, unit: "tablet" };
    const result = expandDoseToDates({ med: {}, dose, prescriptionDate: null, timezone: TZ });
    expect(result).toEqual([dose]);
  });

  it("returns nothing when a date-less dose also has no time", () => {
    const result = expandDoseToDates({ med: {}, dose: { amount: 1 }, prescriptionDate: null, timezone: TZ });
    expect(result).toEqual([]);
  });

  it("expands an open-ended recurring dose across the default window", () => {
    const dose = { time: "08:00", amount: 1, unit: "capsule" };
    const result = expandDoseToDates({ med: {}, dose, prescriptionDate: null, timezone: TZ });
    // Inclusive window today .. today+DEFAULT_RECURRING_DAYS.
    expect(result).toHaveLength(DEFAULT_RECURRING_DAYS + 1);
    expect(result[0].date).toBe(TODAY);
    expect(result[result.length - 1].date).toBe("2026-08-17"); // 2026-07-18 + 30 days
    expect(result.every((d) => d.time === "08:00")).toBe(true);
  });

  it("honors duration_days from the prescription date", () => {
    const dose = { time: "13:00", amount: 2, unit: "tablet" };
    const result = expandDoseToDates({
      med: { duration_days: 7 },
      dose,
      prescriptionDate: TODAY,
      timezone: TZ,
    });
    expect(result).toHaveLength(7);
    expect(result[0].date).toBe(TODAY);
    expect(result[6].date).toBe("2026-07-24");
  });

  it("honors an explicit end_date", () => {
    const dose = { time: "19:00", amount: 1, unit: "drop" };
    const result = expandDoseToDates({
      med: { end_date: "2026-07-20" },
      dose,
      prescriptionDate: TODAY,
      timezone: TZ,
    });
    expect(result.map((d) => d.date)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
  });

  it("never schedules in the past — a back-dated prescription starts today", () => {
    const dose = { time: "08:00", amount: 1, unit: "capsule" };
    const result = expandDoseToDates({
      med: {}, // open-ended
      dose,
      prescriptionDate: "2026-07-08", // 10 days ago
      timezone: TZ,
    });
    // Start is clamped to today, not the back-dated prescription date.
    expect(result[0].date).toBe(TODAY);
  });

  it("returns nothing when a short course already ended before today", () => {
    const dose = { time: "08:00", amount: 1, unit: "tablet" };
    const result = expandDoseToDates({
      med: { duration_days: 3 },
      dose,
      prescriptionDate: "2026-07-08", // ended 2026-07-10, before today
      timezone: TZ,
    });
    expect(result).toEqual([]);
  });

  it("caps expansion at MAX_OCCURRENCES_PER_DOSE", () => {
    const dose = { time: "08:00", amount: 1, unit: "tablet" };
    const result = expandDoseToDates({
      med: { duration_days: 365 },
      dose,
      prescriptionDate: TODAY,
      timezone: TZ,
    });
    expect(result).toHaveLength(MAX_OCCURRENCES_PER_DOSE);
  });
});

describe("buildDosesToSchedule — PRN skip & flattening", () => {
  it("skips PRN medications entirely", () => {
    const prescription = {
      prescription_date: TODAY,
      medications: [
        { name: "paracetamol", schedule_type: "prn", doses: [{ date: "2026-08-01", time: "08:00" }] },
      ],
    };
    const { dosesToSchedule, skippedDoses } = buildDosesToSchedule(prescription, TZ);
    expect(dosesToSchedule).toEqual([]);
    expect(skippedDoses).toEqual([]);
  });

  it("skips individual as_needed doses", () => {
    const prescription = {
      prescription_date: TODAY,
      medications: [
        {
          name: "loperamide",
          schedule_type: "fixed",
          doses: [{ date: "2026-08-01", time: "08:00", as_needed: true }],
        },
      ],
    };
    const { dosesToSchedule } = buildDosesToSchedule(prescription, TZ);
    expect(dosesToSchedule).toEqual([]);
  });

  it("merges medication metadata onto each scheduled dose", () => {
    const prescription = {
      prescription_date: TODAY,
      medications: [
        {
          name: "amoxicillin",
          brand: "Amoxil",
          form: "capsule",
          dose_mg: 500,
          special_instructions: "take with food",
          schedule_type: "fixed",
          doses: [{ date: "2026-08-01", time: "08:00", amount: 1, unit: "capsule" }],
        },
      ],
    };
    const { dosesToSchedule } = buildDosesToSchedule(prescription, TZ);
    expect(dosesToSchedule).toHaveLength(1);
    expect(dosesToSchedule[0]).toMatchObject({
      medication: "amoxicillin",
      brand: "Amoxil",
      form: "capsule",
      dose_mg: 500,
      special_instructions: "take with food",
      date: "2026-08-01",
      time: "08:00",
    });
  });

  it("records unschedulable doses (no date/time) as skipped with the med name", () => {
    const prescription = {
      prescription_date: TODAY,
      medications: [
        { name: "vitamin-d", schedule_type: "fixed", doses: [{ amount: 1, unit: "tablet" }] },
      ],
    };
    const { dosesToSchedule, skippedDoses } = buildDosesToSchedule(prescription, TZ);
    expect(dosesToSchedule).toEqual([]);
    expect(skippedDoses).toHaveLength(1);
    expect(skippedDoses[0]).toMatchObject({ medication: "vitamin-d" });
  });

  it("expands a recurring med while passing a taper through", () => {
    const prescription = {
      prescription_date: TODAY,
      medications: [
        { name: "metformin", schedule_type: "recurring", duration_days: 3, doses: [{ time: "08:00" }] },
        { name: "prednisone", schedule_type: "taper", doses: [{ date: "2026-08-01", time: "08:00" }] },
      ],
    };
    const { dosesToSchedule } = buildDosesToSchedule(prescription, TZ);
    const metformin = dosesToSchedule.filter((d) => d.medication === "metformin");
    const prednisone = dosesToSchedule.filter((d) => d.medication === "prednisone");
    expect(metformin).toHaveLength(3);
    expect(prednisone).toHaveLength(1);
  });
});

describe("isDosePast — past-dose skip", () => {
  it("treats an earlier time today as past", () => {
    // 06:00 Manila today = 22:00Z yesterday, before frozen now (04:00Z today).
    expect(isDosePast({ date: TODAY, time: "06:00" }, TZ)).toBe(true);
  });

  it("treats a later time today as not past", () => {
    // 20:00 Manila today = 12:00Z today, after frozen now.
    expect(isDosePast({ date: TODAY, time: "20:00" }, TZ)).toBe(false);
  });

  it("treats a future date as not past", () => {
    expect(isDosePast({ date: "2026-08-01", time: "08:00" }, TZ)).toBe(false);
  });

  it("treats an unschedulable dose (missing date/time) as past/skip", () => {
    expect(isDosePast({ time: "08:00" }, TZ)).toBe(true);
    expect(isDosePast({ date: TODAY }, TZ)).toBe(true);
  });
});

describe("buildScheduleName — 64-character EventBridge limit", () => {
  it("produces a deterministic name given a fixed unique suffix", () => {
    const name = buildScheduleName({ date: "2026-08-01", time: "08:00", medication: "amoxicillin" }, "abcd1234");
    expect(name).toBe("rx-2026-08-01-0800-amoxicillin-abcd1234");
  });

  it("stays within the 64-char limit for an absurdly long medication name", () => {
    const longName = "supercalifragilisticexpialidocious-antibiotic-compound-XL";
    const name = buildScheduleName({ date: "2026-08-01", time: "08:00", medication: longName });
    expect(name.length).toBeLessThanOrEqual(SCHEDULE_NAME_MAX_LENGTH);
    expect(name).toMatch(/^rx-/);
  });

  it("only ever uses EventBridge-legal characters", () => {
    const name = buildScheduleName({ date: "2026-08-01", time: "08:00", medication: "co-amoxiclav 625mg (Augmentin®)" });
    expect(name).toMatch(/^[a-zA-Z0-9-_]+$/);
    expect(name.length).toBeLessThanOrEqual(SCHEDULE_NAME_MAX_LENGTH);
  });

  it("falls back to 'med' when the medication name is missing", () => {
    const name = buildScheduleName({ date: "2026-08-01", time: "08:00" }, "abcd1234");
    expect(name).toBe("rx-2026-08-01-0800-med-abcd1234");
  });
});

describe("isTotalScheduleFailure — SCHEDULE_CREATE_FAILED trigger", () => {
  it("is true when doses were attempted, none scheduled, and there were creation errors", () => {
    expect(isTotalScheduleFailure(3, 0, 3)).toBe(true);
    expect(isTotalScheduleFailure(3, 0, 1)).toBe(true);
  });

  it("is false when at least one dose was scheduled (partial success)", () => {
    expect(isTotalScheduleFailure(3, 1, 2)).toBe(false);
  });

  it("is false when nothing scheduled but the misses were past-dose skips, not errors", () => {
    expect(isTotalScheduleFailure(3, 0, 0)).toBe(false);
  });

  it("is false when there was nothing to schedule at all", () => {
    expect(isTotalScheduleFailure(0, 0, 0)).toBe(false);
  });
});
