import { describe, it, expect } from "vitest";

import {
  collectRuleNames,
  imagePrefixFor,
  chunk,
  toDeleteRequests,
  isDeleteHandled,
  collectFailures,
} from "../functions/deleteUserData/lib.js";

// The original, imported purely so the equivalence suite at the bottom can prove
// the remaining copy in deleteUserData/lib.js still behaves identically.
import { collectRuleNames as collectRuleNamesOriginal } from "../functions/cancelReminders/lib.js";

describe("imagePrefixFor", () => {
  it("scopes to the user's prescriptions folder", () => {
    expect(imagePrefixFor("user-123")).toBe("user-123/prescriptions/");
  });

  it("interpolates the id RAW, exactly as getUploadUrl writes the key", () => {
    // getUploadUrl builds `${userId}/prescriptions/...` with no sanitisation,
    // because every accepted id has already passed USER_ID_PATTERN at the auth
    // boundary. Sanitising on one side only is the write-vs-search drift that
    // makes an erasure delete nothing while reporting success.
    const uid = "u-3f8a9c12-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
    expect(imagePrefixFor(uid)).toBe(`${uid}/prescriptions/`);
    expect(imagePrefixFor("local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea"))
      .toBe("local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea/prescriptions/");
  });

  it("keeps the trailing slash so a prefix cannot match a longer user id", () => {
    // Without the slash, prefix "abc" would also list "abcd/..." and erasure
    // would delete a different user's prescription images.
    const prefix = imagePrefixFor("abc");
    expect("abcd/prescriptions/page-1.jpg".startsWith(prefix)).toBe(false);
    expect("abc/prescriptions/page-1.jpg".startsWith(prefix)).toBe(true);
  });
});

describe("chunk", () => {
  it("splits into batches no larger than the limit", () => {
    const items = Array.from({ length: 57 }, (_, i) => i);
    const batches = chunk(items, 25);
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 7]);
  });

  it("returns a single batch when the list fits", () => {
    expect(chunk([1, 2, 3], 25)).toEqual([[1, 2, 3]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 25)).toEqual([]);
  });

  it("never exceeds the S3 1000-key cap on a large set", () => {
    const keys = Array.from({ length: 2500 }, (_, i) => ({ Key: `k${i}` }));
    const batches = chunk(keys, 1000);
    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.length <= 1000)).toBe(true);
    expect(batches.flat()).toHaveLength(2500);
  });

  it("guards against a zero or negative size rather than looping forever", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([]);
    expect(chunk([1, 2, 3], -1)).toEqual([]);
  });
});

describe("toDeleteRequests", () => {
  it("builds a DeleteRequest carrying only the table's key attributes", () => {
    const items = [
      { userId: "u1", scheduleId: "s1", contactInfo: "a@b.com", medications: [{}] },
    ];
    expect(toDeleteRequests(items, ["userId", "scheduleId"])).toEqual([
      { DeleteRequest: { Key: { userId: "u1", scheduleId: "s1" } } },
    ]);
  });

  it("handles the prescriptions table's different sort key", () => {
    const items = [{ userId: "u1", prescriptionId: "rx-1" }];
    expect(toDeleteRequests(items, ["userId", "prescriptionId"])).toEqual([
      { DeleteRequest: { Key: { userId: "u1", prescriptionId: "rx-1" } } },
    ]);
  });

  it("skips rows missing a key attribute instead of sending an invalid request", () => {
    const items = [
      { userId: "u1", scheduleId: "s1" },
      { userId: "u1" },                    // no sort key — would be rejected by DynamoDB
    ];
    expect(toDeleteRequests(items, ["userId", "scheduleId"])).toHaveLength(1);
  });

  it("returns nothing for an empty query result", () => {
    expect(toDeleteRequests([], ["userId", "scheduleId"])).toEqual([]);
    expect(toDeleteRequests(undefined, ["userId", "scheduleId"])).toEqual([]);
  });
});

describe("isDeleteHandled", () => {
  it("counts a successful delete", () => {
    expect(isDeleteHandled({ status: "fulfilled" })).toBe(true);
  });

  it("counts an already-gone schedule rule, which is what makes erasure retryable", () => {
    const result = { status: "rejected", reason: { name: "ResourceNotFoundException" } };
    expect(isDeleteHandled(result)).toBe(true);
  });

  it("does NOT count a permission failure as handled", () => {
    const result = { status: "rejected", reason: { name: "AccessDeniedException" } };
    expect(isDeleteHandled(result)).toBe(false);
  });
});

describe("collectFailures", () => {
  it("reports only genuine failures, not already-gone rules", () => {
    const results = [
      { status: "fulfilled" },
      { status: "rejected", reason: { name: "ResourceNotFoundException", message: "gone" } },
      { status: "rejected", reason: { name: "AccessDeniedException", message: "denied" } },
    ];
    expect(collectFailures(results)).toEqual(["denied"]);
  });

  it("returns an empty list when everything succeeded", () => {
    expect(collectFailures([{ status: "fulfilled" }, { status: "fulfilled" }])).toEqual([]);
  });

  it("falls back to a placeholder when a rejection carries no message", () => {
    const results = [{ status: "rejected", reason: { name: "Weird" } }];
    expect(collectFailures(results)).toEqual(["unknown error"]);
  });

  it("is what stops a half-failed erasure reporting success", () => {
    // Promise.allSettled never throws, so without this the handler would return
    // 200 while prescription images were still sitting in S3.
    const results = [{ status: "rejected", reason: { name: "AccessDeniedException", message: "denied" } }];
    expect(collectFailures(results).length).toBeGreaterThan(0);
  });
});

// ── Drift guard ─────────────────────────────────────────────────────────────
// verifySessionToken and collectRuleNames are copied from cancelReminders/lib.js
// because SAM packages each function's CodeUri on its own and a cross-directory
// require would throw at runtime. These tests fail the moment the two diverge.
describe("collectRuleNames stays identical to cancelReminders/lib.js", () => {
  // verifySessionToken used to be copied here too and had its own equivalence
  // suite. It now lives in the rx-session-token layer, so there is one
  // implementation and nothing to drift. collectRuleNames is still a copy --
  // SAM packages each CodeUri alone, and scheduling logic does not belong in an
  // auth layer -- so this guard remains.
  const scheduleCases = [
    ["no schedules",            []],
    ["undefined",               undefined],
    ["schedule with no doses",  [{ scheduleId: "s1" }]],
    ["doses missing rule names", [{ scheduledDoses: [{ scheduleName: "r1" }, {}] }]],
    ["multiple schedules",      [{ scheduledDoses: [{ scheduleName: "r1" }] },
                                 { scheduledDoses: [{ scheduleName: "r2" }, { scheduleName: "r3" }] }]],
  ];

  it.each(scheduleCases)("agrees on: %s", (_name, schedules) => {
    expect(collectRuleNames(schedules)).toEqual(collectRuleNamesOriginal(schedules));
  });
});

// ── Erasure-specific behaviour the cancel path does not have ────────────────
describe("erasure covers records the cancel path skips", () => {
  it("collects rule names from cancelled schedules too", () => {
    // cancelReminders queries with `active = true`; erasure must not, or a user
    // who stopped reminders first would keep every record forever.
    const schedules = [
      { active: false, processingStatus: "cancelled", scheduledDoses: [{ scheduleName: "r1" }] },
    ];
    expect(collectRuleNames(schedules)).toEqual(["r1"]);
  });

  it("builds delete requests for rows regardless of active state", () => {
    const items = [
      { userId: "u1", scheduleId: "s1", active: false },
      { userId: "u1", scheduleId: "s2", active: true },
    ];
    expect(toDeleteRequests(items, ["userId", "scheduleId"])).toHaveLength(2);
  });
});
