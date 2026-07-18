import { describe, it, expect } from "vitest";

import {
  signSessionToken,
  buildSessionUrl,
  buildUnsubscribeUrl,
  buildHtmlEmail,
  formatDoseMessage,
  formatDailySummaryMessage,
  formatTestMessage,
  formatSubscribedMessage,
} from "../functions/notifyUser/email.js";

const APP_URL = "https://textit2medoc.example.net";
const SECRET = "test-magic-link-secret";
const CONFIG = { appUrl: APP_URL, secret: SECRET };
const USER_ID = "user-123";

describe("session-token signing & links", () => {
  it("signs a token with two base64url parts", () => {
    const token = signSessionToken(USER_ID, SECRET);
    expect(token).toBeTruthy();
    expect(token.split(".")).toHaveLength(2);
  });

  it("returns null when the secret or userId is missing", () => {
    expect(signSessionToken(USER_ID, "")).toBeNull();
    expect(signSessionToken("", SECRET)).toBeNull();
  });

  it("builds a session URL carrying the signed token", () => {
    const url = buildSessionUrl(USER_ID, CONFIG);
    expect(url.startsWith(`${APP_URL}/?token=`)).toBe(true);
  });

  it("builds an unsubscribe URL carrying the user id and token", () => {
    const url = buildUnsubscribeUrl(USER_ID, CONFIG);
    expect(url).toContain(`unsubscribe=${USER_ID}`);
    expect(url).toContain("&token=");
  });

  it("falls back gracefully when no secret is configured", () => {
    expect(buildSessionUrl(USER_ID, { appUrl: APP_URL })).toBe(APP_URL);
    expect(buildUnsubscribeUrl(USER_ID, { appUrl: APP_URL })).toBe(`${APP_URL}/?unsubscribe=${USER_ID}`);
  });

  it("returns no unsubscribe URL without a user id", () => {
    expect(buildUnsubscribeUrl("", CONFIG)).toBeNull();
  });
});

describe("buildHtmlEmail — session & unsubscribe links in the template", () => {
  it("embeds the exact signed session and unsubscribe links (subscribed email)", () => {
    const sessionUrl = buildSessionUrl(USER_ID, CONFIG);
    const unsubscribeUrl = buildUnsubscribeUrl(USER_ID, CONFIG);

    const html = buildHtmlEmail(
      { type: "subscribed", userId: USER_ID, medications: [{ name: "metformin", dose_mg: 500 }], dosesScheduled: 3 },
      CONFIG,
    );

    expect(html).toContain(`href="${sessionUrl}"`);
    expect(html).toContain(`href="${unsubscribeUrl}"`);
    expect(html).toContain("Unsubscribe");
  });

  it("renders the unsubscribe footer for a dose reminder when a user id is present", () => {
    const unsubscribeUrl = buildUnsubscribeUrl(USER_ID, CONFIG);
    const html = buildHtmlEmail(
      { type: "dose", userId: USER_ID, dose: { medication: "amoxicillin", amount: 1, unit: "capsule", time: "08:00" } },
      CONFIG,
    );
    expect(html).toContain(`href="${unsubscribeUrl}"`);
  });

  it("omits the unsubscribe footer when there is no user id", () => {
    const html = buildHtmlEmail(
      { type: "dose", dose: { medication: "amoxicillin", amount: 1, unit: "capsule", time: "08:00" } },
      CONFIG,
    );
    expect(html).not.toContain("Unsubscribe");
  });

  it("renders every message type without throwing", () => {
    const types = [
      { type: "subscribed", userId: USER_ID, medications: [], dosesScheduled: 0 },
      { type: "test", userId: USER_ID },
      { type: "daily_summary", userId: USER_ID, doses: [{ medication: "aspirin", amount: 1, unit: "tablet", time: "08:00" }] },
      { type: "dose", userId: USER_ID, dose: { medication: "aspirin", amount: 1, unit: "tablet", time: "08:00" } },
      { bodyText: "plain fallback", userId: USER_ID },
    ];
    for (const params of types) {
      const html = buildHtmlEmail(params, CONFIG);
      expect(html).toContain("<!DOCTYPE html>");
    }
  });
});

describe("plain-text formatters", () => {
  it("formats a dose reminder", () => {
    const msg = formatDoseMessage({ medication: "amoxicillin", brand: "Amoxil", amount: 1, unit: "capsule", instruction: "after breakfast" });
    expect(msg).toContain("amoxicillin (Amoxil)");
    expect(msg).toContain("1 capsule");
    expect(msg).toContain("after breakfast");
  });

  it("handles an empty daily summary", () => {
    expect(formatDailySummaryMessage([])).toContain("No medications scheduled");
  });

  it("labels the test channel by method", () => {
    expect(formatTestMessage("sms")).toContain("SMS");
    expect(formatTestMessage("email")).toContain("email");
  });

  it("lists medications in the subscribed message", () => {
    const msg = formatSubscribedMessage({ medications: [{ name: "metformin", dose_mg: 500 }], dosesScheduled: 3, userTimezone: "Asia/Manila" });
    expect(msg).toContain("metformin");
    expect(msg).toContain("3 dose reminder(s)");
  });
});
