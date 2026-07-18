import { describe, it, expect } from "vitest";

import {
  SCHEDULE_STATUS,
  scheduleStatus,
  pickCurrentSchedule,
  summarizeSchedule,
} from "./schedule.js";

describe("scheduleStatus", () => {
  it("returns active for a live, completed schedule", () => {
    expect(scheduleStatus({ active: true, processingStatus: "complete" })).toBe(SCHEDULE_STATUS.ACTIVE);
  });

  it("returns cancelled when processingStatus is cancelled", () => {
    expect(scheduleStatus({ active: false, processingStatus: "cancelled" })).toBe(SCHEDULE_STATUS.CANCELLED);
  });

  it("returns cancelled when inactive with a cancelledAt timestamp", () => {
    expect(scheduleStatus({ active: false, cancelledAt: "2026-07-18T00:00:00Z" })).toBe(SCHEDULE_STATUS.CANCELLED);
  });

  it("returns processing/failed from processingStatus", () => {
    expect(scheduleStatus({ active: false, processingStatus: "processing" })).toBe(SCHEDULE_STATUS.PROCESSING);
    expect(scheduleStatus({ active: false, processingStatus: "failed" })).toBe(SCHEDULE_STATUS.FAILED);
  });

  it("returns inactive for an inactive schedule with no cancel marker, and for nullish input", () => {
    expect(scheduleStatus({ active: false })).toBe(SCHEDULE_STATUS.INACTIVE);
    expect(scheduleStatus(null)).toBe(SCHEDULE_STATUS.INACTIVE);
  });
});

describe("pickCurrentSchedule", () => {
  it("returns null for empty/nullish input", () => {
    expect(pickCurrentSchedule([])).toBeNull();
    expect(pickCurrentSchedule(null)).toBeNull();
    expect(pickCurrentSchedule([null, undefined])).toBeNull();
  });

  it("prefers the most recently updated active schedule over a newer cancelled one", () => {
    const cancelledNewer = { scheduleId: "c", active: false, processingStatus: "cancelled", updatedAt: "2026-07-18T10:00:00Z" };
    const activeOlder = { scheduleId: "a", active: true, processingStatus: "complete", updatedAt: "2026-07-18T09:00:00Z" };
    expect(pickCurrentSchedule([cancelledNewer, activeOlder]).scheduleId).toBe("a");
  });

  it("picks the most recent active when several are active", () => {
    const older = { scheduleId: "old", active: true, processingStatus: "complete", updatedAt: "2026-07-10T00:00:00Z" };
    const newer = { scheduleId: "new", active: true, processingStatus: "complete", updatedAt: "2026-07-18T00:00:00Z" };
    expect(pickCurrentSchedule([older, newer]).scheduleId).toBe("new");
  });

  it("falls back to the most recent of any status when none are active", () => {
    const a = { scheduleId: "a", active: false, processingStatus: "cancelled", updatedAt: "2026-07-10T00:00:00Z" };
    const b = { scheduleId: "b", active: false, processingStatus: "cancelled", updatedAt: "2026-07-18T00:00:00Z" };
    expect(pickCurrentSchedule([a, b]).scheduleId).toBe("b");
  });
});

describe("summarizeSchedule", () => {
  it("returns null for nullish input", () => {
    expect(summarizeSchedule(null)).toBeNull();
  });

  it("normalizes the display fields", () => {
    const schedule = {
      active: true,
      processingStatus: "complete",
      createdAt: "2026-07-18T08:00:00Z",
      updatedAt: "2026-07-18T08:05:00Z",
      notificationMethod: "email",
      contactInfo: "you@example.com",
      userTimezone: "Asia/Manila",
      scheduledDoses: [{}, {}, {}],
      medications: [{ name: "metformin" }, { name: "amoxicillin" }],
    };
    expect(summarizeSchedule(schedule)).toEqual({
      status: "active",
      createdAt: "2026-07-18T08:00:00Z",
      updatedAt: "2026-07-18T08:05:00Z",
      cancelledAt: null,
      channel: "email",
      contact: "you@example.com",
      timezone: "Asia/Manila",
      doseCount: 3,
      medCount: 2,
    });
  });

  it("falls back to prescription.medications for the med count", () => {
    const schedule = { active: true, prescription: { medications: [{ name: "a" }] } };
    expect(summarizeSchedule(schedule).medCount).toBe(1);
    expect(summarizeSchedule(schedule).doseCount).toBe(0);
  });
});
