import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

import {
  verifySessionToken,
  collectRuleNames,
  safeSegment,
  imagePrefixFor,
  chunk,
  toDeleteRequests,
  isDeleteHandled,
  collectFailures,
} from "../functions/deleteUserData/lib.js";

// The originals, imported purely so the equivalence suite at the bottom can
// prove the copies in deleteUserData/lib.js still behave identically.
import {
  verifySessionToken as verifyOriginal,
  collectRuleNames as collectRuleNamesOriginal,
} from "../functions/cancelReminders/lib.js";

const SECRET = "test-magic-link-secret";

function signToken(uid, exp, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ uid, exp })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("safeSegment", () => {
  // Pinned against getUploadUrl/index.js:35-42. If that ever changes, erasure
  // starts listing a prefix the images were never written under — deleting
  // nothing while reporting success. These cases are the guard.
  it("leaves a normal generated user id untouched", () => {
    expect(safeSegment("local-3f8a9c12-4b5d-4e6f-8a9b-0c1d2e3f4a5b"))
      .toBe("local-3f8a9c12-4b5d-4e6f-8a9b-0c1d2e3f4a5b");
  });

  it("rewrites characters that are not alphanumeric, dash or underscore", () => {
    expect(safeSegment("user.123")).toBe("user-123");
    expect(safeSegment("user/123")).toBe("user-123");
    expect(safeSegment("user 123")).toBe("user-123");
  });

  it("collapses runs of dashes and trims the ends", () => {
    expect(safeSegment("a...b")).toBe("a-b");
    expect(safeSegment("-abc-")).toBe("abc");
  });

  it("truncates at 120 characters", () => {
    expect(safeSegment("a".repeat(200))).toHaveLength(120);
  });

  it("handles empty and nullish input", () => {
    expect(safeSegment("")).toBe("");
    expect(safeSegment(undefined)).toBe("");
    expect(safeSegment(null)).toBe("");
  });
});

describe("imagePrefixFor", () => {
  it("scopes to the user's prescriptions folder", () => {
    expect(imagePrefixFor("user-123")).toBe("user-123/prescriptions/");
  });

  it("sanitises the same way getUploadUrl does when it writes the key", () => {
    // getUploadUrl stores at `${safeSegment(userId)}/prescriptions/...`. An
    // unsanitised prefix here would list a path nothing was written to, delete
    // zero objects, and still report success.
    expect(imagePrefixFor("user.123")).toBe("user-123/prescriptions/");
    expect(imagePrefixFor("a/b/c")).toBe("a-b-c/prescriptions/");
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
describe("copies stay identical to cancelReminders/lib.js", () => {
  const now = 1_780_000_000;

  const tokenCases = [
    ["valid token",                signToken("user-123", now + 1000)],
    ["expired token",              signToken("user-123", now - 1)],
    ["wrong secret",               signToken("user-123", now + 1000, "other-secret")],
    ["tampered signature",         `${signToken("user-123", now + 1000).split(".")[0]}.deadbeef`],
    ["malformed, no signature",    "not-a-real-token"],
    ["empty string",               ""],
    ["three parts",                "a.b.c"],
    ["payload that is not JSON",   `${Buffer.from("nonsense").toString("base64url")}.x`],
  ];

  it.each(tokenCases)("verifySessionToken agrees on: %s", (_name, token) => {
    expect(verifySessionToken(token, SECRET, now)).toEqual(verifyOriginal(token, SECRET, now));
  });

  it("verifySessionToken agrees when the secret is missing", () => {
    const token = signToken("user-123", now + 1000);
    expect(verifySessionToken(token, "", now)).toEqual(verifyOriginal(token, "", now));
  });

  const scheduleCases = [
    ["no schedules",            []],
    ["undefined",               undefined],
    ["schedule with no doses",  [{ scheduleId: "s1" }]],
    ["doses missing rule names", [{ scheduledDoses: [{ scheduleName: "r1" }, {}] }]],
    ["multiple schedules",      [{ scheduledDoses: [{ scheduleName: "r1" }] },
                                 { scheduledDoses: [{ scheduleName: "r2" }, { scheduleName: "r3" }] }]],
  ];

  it.each(scheduleCases)("collectRuleNames agrees on: %s", (_name, schedules) => {
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
