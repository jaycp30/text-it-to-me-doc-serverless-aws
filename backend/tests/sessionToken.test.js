import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

import {
  TOKEN_TTL_SECONDS,
  USER_ID_PATTERN,
  isSafeUserId,
  newUserId,
  signSessionToken,
  verifySessionToken,
} from "rx-session-token";

const SECRET = "test-magic-link-secret";
const NOW = 1_780_000_000;

function signRaw(payloadObj, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("newUserId", () => {
  it("mints a prefixed uuid", () => {
    expect(newUserId()).toMatch(/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 500 }, newUserId));
    expect(ids.size).toBe(500);
  });

  it("always produces a safe id", () => {
    expect(isSafeUserId(newUserId())).toBe(true);
  });
});

describe("isSafeUserId", () => {
  it("accepts server-minted and legacy ids already in the table", () => {
    expect(isSafeUserId("u-3f8a9c12-4b5d-4e6f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isSafeUserId("local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea")).toBe(true);
    expect(isSafeUserId("codex-qa-20260531-0543")).toBe(true);
  });

  it("rejects anything that would change an S3 key's shape", () => {
    // This is the whole point: a uid containing one of these would be written
    // under one prefix and searched for under another.
    expect(isSafeUserId("a/b")).toBe(false);
    expect(isSafeUserId("a.b")).toBe(false);
    expect(isSafeUserId("a b")).toBe(false);
    expect(isSafeUserId("../../etc")).toBe(false);
    expect(isSafeUserId("a\nb")).toBe(false);
  });

  it("rejects empty, oversized and non-string input", () => {
    expect(isSafeUserId("")).toBe(false);
    expect(isSafeUserId("a".repeat(121))).toBe(false);
    expect(isSafeUserId(undefined)).toBe(false);
    expect(isSafeUserId(null)).toBe(false);
    expect(isSafeUserId(123)).toBe(false);
  });

  it("agrees with the exported pattern", () => {
    expect(USER_ID_PATTERN.test("u-abc")).toBe(isSafeUserId("u-abc"));
  });
});

describe("signSessionToken / verifySessionToken round trip", () => {
  it("round-trips a minted identity", () => {
    const uid = newUserId();
    const token = signSessionToken(uid, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toBe(uid);
  });

  it("expires exactly TOKEN_TTL_SECONDS after signing", () => {
    const token = signSessionToken("u-abc", SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW + TOKEN_TTL_SECONDS)).toBe("u-abc");
    expect(verifySessionToken(token, SECRET, NOW + TOKEN_TTL_SECONDS + 1)).toBeNull();
  });

  it("refuses to sign without a secret or without an id", () => {
    expect(signSessionToken("u-abc", "")).toBeNull();
    expect(signSessionToken("", SECRET)).toBeNull();
  });

  it("refuses to sign an id it would later refuse to verify", () => {
    // Asymmetry here is a silent failure loop: notifyUser signs a link for a
    // legacy uid, SES delivers it, and every click 401s with nothing logged.
    // Returning null makes the URL builders degrade to the bare app URL, and
    // the console.error is the CloudWatch signal that it happened.
    for (const bad of ["a.b", "a/b", "has space", "x".repeat(121), "../etc"]) {
      expect(signSessionToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("still signs legacy ids that predate the pattern but satisfy it", () => {
    expect(signSessionToken("local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea", SECRET, NOW)).toBeTruthy();
    expect(signSessionToken("codex-qa-20260531-0543", SECRET, NOW)).toBeTruthy();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSessionToken("u-abc", "other-secret", NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered payload keeping the original signature", () => {
    const token = signSessionToken("u-victim", SECRET, NOW);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "u-attacker", exp: NOW + 1000 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", "nope", "a.b.c", "....", undefined, null, 42, {}]) {
      expect(verifySessionToken(bad, SECRET, NOW)).toBeNull();
    }
  });
});

describe("verifySessionToken rejects unsafe ids even when correctly signed", () => {
  // Defence in depth for the window before identities were server-minted: a
  // token could have been signed for any string a client sent. Rejecting the
  // shape at the auth boundary is what lets every caller treat a verified uid as
  // safe to interpolate into an S3 key or a log line.
  const cases = [
    ["path traversal", "../../other-user"],
    ["prefix escape",  "victim/prescriptions"],
    ["whitespace",     "u abc"],
    ["newline (log injection)", "u-abc\nFAKE LOG LINE"],
    ["over length",    "u-" + "a".repeat(200)],
  ];

  it.each(cases)("rejects a validly signed token carrying %s", (_name, uid) => {
    const token = signRaw({ uid, exp: NOW + 1000 });
    // The signature is genuine — only the shape of the id is wrong.
    expect(token.split(".")).toHaveLength(2);
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("still accepts a validly signed legacy id", () => {
    const token = signRaw({ uid: "local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea", exp: NOW + 1000 });
    expect(verifySessionToken(token, SECRET, NOW)).toBe("local-400dbaf6-f12d-4e1a-a8e5-6ec1624e45ea");
  });
});
