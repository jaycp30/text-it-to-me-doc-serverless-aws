import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

import {
  verifySessionToken,
  collectRuleNames,
  isCancelHandled,
  countCancelled,
} from "../functions/cancelReminders/lib.js";

const SECRET = "test-magic-link-secret";

// Local signer mirroring the server's token format, so tests don't depend on
// the notifyUser module to mint tokens.
function signToken(uid, exp, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify({ uid, exp })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("verifySessionToken", () => {
  const now = 1_780_000_000; // fixed Unix seconds

  it("accepts a valid, unexpired token and returns the uid", () => {
    const token = signToken("user-123", now + 1000);
    expect(verifySessionToken(token, SECRET, now)).toBe("user-123");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken("user-123", now + 1000, "wrong-secret");
    expect(verifySessionToken(token, SECRET, now)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signToken("user-123", now - 1);
    expect(verifySessionToken(token, SECRET, now)).toBeNull();
  });

  it("rejects a malformed token (no signature part)", () => {
    expect(verifySessionToken("not-a-real-token", SECRET, now)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signToken("user-123", now + 1000);
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ uid: "attacker", exp: now + 1000 })).toString("base64url");
    expect(verifySessionToken(`${forgedPayload}.${sig}`, SECRET, now)).toBeNull();
  });

  it("returns null when no secret is configured", () => {
    const token = signToken("user-123", now + 1000);
    expect(verifySessionToken(token, "", now)).toBeNull();
  });

  it("returns null for a missing token", () => {
    expect(verifySessionToken(undefined, SECRET, now)).toBeNull();
  });
});

describe("collectRuleNames", () => {
  it("flattens rule names across a user's schedule records", () => {
    const schedules = [
      { scheduledDoses: [{ scheduleName: "rx-a" }, { scheduleName: "rx-b" }] },
      { scheduledDoses: [{ scheduleName: "rx-c" }] },
    ];
    expect(collectRuleNames(schedules)).toEqual(["rx-a", "rx-b", "rx-c"]);
  });

  it("skips doses that never got a rule name", () => {
    const schedules = [
      { scheduledDoses: [{ scheduleName: "rx-a" }, { scheduleName: undefined }, {}] },
    ];
    expect(collectRuleNames(schedules)).toEqual(["rx-a"]);
  });

  it("handles records with no scheduledDoses and an empty input", () => {
    expect(collectRuleNames([{ scheduleId: "s1" }, { scheduledDoses: [] }])).toEqual([]);
    expect(collectRuleNames([])).toEqual([]);
    expect(collectRuleNames(undefined)).toEqual([]);
  });
});

describe("countCancelled — unsubscribe idempotency", () => {
  it("counts successful deletes", () => {
    const results = [{ status: "fulfilled" }, { status: "fulfilled" }];
    expect(countCancelled(results)).toBe(2);
  });

  it("counts an already-deleted rule (ResourceNotFoundException) as handled", () => {
    // This is the idempotency guarantee: re-running unsubscribe, or unsubscribing
    // after a rule has already fired-and-auto-deleted, still succeeds.
    const results = [
      { status: "fulfilled" },
      { status: "rejected", reason: { name: "ResourceNotFoundException" } },
    ];
    expect(countCancelled(results)).toBe(2);
  });

  it("does not count a genuine failure", () => {
    const results = [
      { status: "fulfilled" },
      { status: "rejected", reason: { name: "ThrottlingException" } },
    ];
    expect(countCancelled(results)).toBe(1);
  });

  it("is safe on an empty result set (nothing to cancel)", () => {
    expect(countCancelled([])).toBe(0);
    expect(countCancelled(undefined)).toBe(0);
  });

  it("isCancelHandled classifies each result type correctly", () => {
    expect(isCancelHandled({ status: "fulfilled" })).toBe(true);
    expect(isCancelHandled({ status: "rejected", reason: { name: "ResourceNotFoundException" } })).toBe(true);
    expect(isCancelHandled({ status: "rejected", reason: { name: "AccessDenied" } })).toBe(false);
  });
});
