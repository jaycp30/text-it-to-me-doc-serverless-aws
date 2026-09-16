import { describe, it, expect } from "vitest";

import {
  JOB_POLL_INTERVAL_MS,
  JOB_POLL_DEADLINE_MS,
  isAsyncJobResponse,
  findJob,
  interpretJobRecord,
  isPollExpired,
} from "./job.js";

describe("isAsyncJobResponse — telling the two backend shapes apart", () => {
  it("recognises a 202 job hand-off", () => {
    expect(isAsyncJobResponse({ status: "processing", scheduleId: "sched-abc" })).toBe(true);
  });

  // The old synchronous handler answers 200 with the prescription inline. The
  // frontend deploys automatically on merge while the backend needs a manual
  // sam deploy, so both shapes are live at once during that window.
  it("treats a legacy synchronous result as not-a-job", () => {
    expect(isAsyncJobResponse({
      scheduleId: "sched-abc",
      prescription: { medications: [{ name: "amoxicillin" }] },
    })).toBe(false);
  });

  it("does not mistake a job for a response missing its scheduleId", () => {
    expect(isAsyncJobResponse({ status: "processing" })).toBe(false);
  });

  it.each([[null], [undefined], [{}], ["processing"]])("rejects %p", (value) => {
    expect(isAsyncJobResponse(value)).toBe(false);
  });
});

describe("findJob — locating this job in a /schedules response", () => {
  const schedules = [
    { scheduleId: "sched-other", processingStatus: "complete" },
    { scheduleId: "sched-mine", processingStatus: "processing" },
  ];

  it("finds the matching record", () => {
    expect(findJob(schedules, "sched-mine")).toBe(schedules[1]);
  });

  it("returns null when the record has not appeared yet", () => {
    expect(findJob(schedules, "sched-missing")).toBeNull();
  });

  it.each([[null], [undefined], ["not-an-array"]])("tolerates a %p schedules payload", (value) => {
    expect(findJob(value, "sched-mine")).toBeNull();
  });

  it("returns null without a scheduleId to look for", () => {
    expect(findJob(schedules, undefined)).toBeNull();
  });
});

describe("interpretJobRecord — reducing a record to a UI state", () => {
  it("treats a missing record as still pending", () => {
    // DynamoDB reads are eventually consistent, so a brief absence right after
    // the 202 is normal and must not be read as failure.
    expect(interpretJobRecord(null)).toMatchObject({ state: "pending", stage: null });
  });

  it("reports the worker's stage while processing", () => {
    const r = interpretJobRecord({ processingStatus: "processing", processingStage: "reading" });
    expect(r).toMatchObject({ state: "pending", stage: "reading" });
  });

  it("stays pending with no stage recorded yet", () => {
    const r = interpretJobRecord({ processingStatus: "processing" });
    expect(r).toMatchObject({ state: "pending", stage: null });
  });

  it("reports completion", () => {
    const record = { processingStatus: "complete", prescription: { medications: [] } };
    expect(interpretJobRecord(record)).toMatchObject({ state: "complete", record });
  });

  it("carries the stable failure code so the UI can be specific", () => {
    const r = interpretJobRecord({
      processingStatus: "failed",
      failureCode: "IMAGE_UNREADABLE",
      failureMessage: "Could not read this prescription.",
    });
    expect(r).toMatchObject({
      state: "failed",
      code: "IMAGE_UNREADABLE",
      message: "Could not read this prescription.",
    });
  });

  it("falls back to a generic code for records written before failureCode existed", () => {
    const r = interpretJobRecord({ processingStatus: "failed", failureMessage: "boom" });
    expect(r.code).toBe("PROCESSING_FAILED");
  });
});

describe("isPollExpired — the client-side deadline", () => {
  it("keeps waiting inside the deadline", () => {
    expect(isPollExpired(1000, 1000 + JOB_POLL_DEADLINE_MS - 1)).toBe(false);
  });

  // Without this the user watches an endless spinner whenever the worker is
  // killed outright, because its catch block never runs to mark the record.
  it("gives up once the deadline passes", () => {
    expect(isPollExpired(1000, 1000 + JOB_POLL_DEADLINE_MS)).toBe(true);
  });

  it("honours an explicit deadline override", () => {
    expect(isPollExpired(0, 500, 400)).toBe(true);
    expect(isPollExpired(0, 300, 400)).toBe(false);
  });
});

describe("polling constants", () => {
  it("polls often enough to feel responsive but not to hammer the API", () => {
    expect(JOB_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(JOB_POLL_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });

  it("allows well beyond a typical 30-60s Bedrock read", () => {
    expect(JOB_POLL_DEADLINE_MS).toBeGreaterThan(90000);
  });
});
