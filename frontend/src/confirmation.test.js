import { describe, it, expect } from "vitest";

import {
  RESEND_COOLDOWN_MS,
  deriveConfirmationStatus,
  canResend,
  cooldownRemainingMs,
} from "./confirmation.js";

describe("deriveConfirmationStatus", () => {
  it("returns null for SMS setups (no email confirmation)", () => {
    expect(deriveConfirmationStatus({ channel: "email", queued: true }, "sms")).toBeNull();
    expect(deriveConfirmationStatus(null, "sms")).toBeNull();
  });

  it("reports 'sent' when the email was queued", () => {
    expect(deriveConfirmationStatus({ channel: "email", queued: true }, "email")).toEqual({
      state: "sent",
      channel: "email",
    });
  });

  it("reports 'failed' when the email could not be queued", () => {
    expect(deriveConfirmationStatus({ channel: "email", queued: false }, "email")).toEqual({
      state: "failed",
      channel: "email",
    });
  });

  it("reports 'unknown' for an email setup with no status (e.g. idempotent replay)", () => {
    expect(deriveConfirmationStatus(null, "email")).toEqual({ state: "unknown", channel: "email" });
    expect(deriveConfirmationStatus(undefined, "email")).toEqual({ state: "unknown", channel: "email" });
  });
});

describe("canResend / cooldownRemainingMs", () => {
  const now = 1_000_000;

  it("allows a resend when nothing has been sent yet", () => {
    expect(canResend(null, now)).toBe(true);
    expect(cooldownRemainingMs(null, now)).toBe(0);
  });

  it("blocks a resend while within the cooldown window", () => {
    const lastSent = now - (RESEND_COOLDOWN_MS - 1000);
    expect(canResend(lastSent, now)).toBe(false);
    expect(cooldownRemainingMs(lastSent, now)).toBe(1000);
  });

  it("allows a resend once the cooldown has elapsed", () => {
    const lastSent = now - RESEND_COOLDOWN_MS;
    expect(canResend(lastSent, now)).toBe(true);
    expect(cooldownRemainingMs(lastSent, now)).toBe(0);
  });
});
