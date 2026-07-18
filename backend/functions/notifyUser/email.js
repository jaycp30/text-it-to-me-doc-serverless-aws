"use strict";

/**
 * email.js
 *
 * Pure message + email-template builders extracted from notifyUser/index.js so
 * they can be unit-tested without SNS/SES. The session-token signing and the
 * session/unsubscribe links are the security-relevant bits under test — see
 * backend/tests/email.test.js.
 *
 * Config (app URL + signing secret) is passed in explicitly rather than read
 * from module-scope env, so tests can sign and assert links deterministically.
 */

const { createHmac } = require("crypto");

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * Sign an HMAC session token: base64url(payload).base64url(HMAC-SHA256).
 * @param {string} userId
 * @param {string} secret
 * @param {number} [nowSeconds] injectable clock for tests
 * @returns {string|null}
 */
function signSessionToken(userId, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !userId) return null;
  const exp = nowSeconds + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Deep-link back into the app with a signed session token so the user can reopen
 * their schedule with no login. Falls back to the bare app URL when unsigned.
 * @param {string} userId
 * @param {{ appUrl: string, secret?: string }} config
 */
function buildSessionUrl(userId, { appUrl, secret } = {}) {
  if (!userId) return appUrl;
  const token = signSessionToken(userId, secret);
  return token ? `${appUrl}/?token=${encodeURIComponent(token)}` : appUrl;
}

/**
 * One-click unsubscribe link carrying the user id and a signed session token.
 * @param {string} userId
 * @param {{ appUrl: string, secret?: string }} config
 */
function buildUnsubscribeUrl(userId, { appUrl, secret } = {}) {
  if (!userId) return null;
  const token = signSessionToken(userId, secret);
  return token
    ? `${appUrl}/?unsubscribe=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}`
    : `${appUrl}/?unsubscribe=${encodeURIComponent(userId)}`;
}

// ─── Message formatters (plain text — used for SMS and email fallback) ────────

function formatDoseMessage(dose) {
  const medName = dose.brand
    ? `${dose.medication} (${dose.brand})`
    : dose.medication;

  const amount = `${dose.amount} ${dose.unit}`;
  const instruction = dose.instruction || "";
  const notes = dose.notes ? ` — ${dose.notes}` : "";
  const special = dose.special_instructions ? `\n${dose.special_instructions}` : "";

  return `Medication reminder: Take ${amount} of ${medName}${instruction ? " " + instruction : ""}${notes}.${special}`;
}

function formatDailySummaryMessage(doses) {
  if (!doses || doses.length === 0) {
    return "RxReader: No medications scheduled for today.";
  }

  const lines = doses.map((dose) => {
    const medName = dose.brand ? `${dose.brand} (${dose.medication})` : dose.medication;
    return `• ${dose.time} — ${dose.amount} ${dose.unit} ${medName}${dose.notes ? " [" + dose.notes + "]" : ""}`;
  });

  return `Good morning! Today's medications:\n\n${lines.join("\n")}\n\nStay healthy — RxReader`;
}

function formatTestMessage(method) {
  const channel = method === "sms" ? "SMS" : "email";
  return `RxReader test: Your ${channel} medication reminders are working. Future dose reminders will be sent here.`;
}

function formatSubscribedMessage({ medications = [], dosesScheduled = 0, userTimezone = "" }) {
  const medLines = medications
    .map(m => `• ${m.name || m.medication || "Unknown"}${m.dose_mg ? ` (${m.dose_mg}mg)` : ""}`)
    .join("\n");

  return [
    "You're subscribed to RxReader medication reminders.",
    "",
    medications.length > 0 ? `Medications found:\n${medLines}` : "",
    "",
    `${dosesScheduled} dose reminder(s) scheduled. You'll receive:`,
    `- A daily medication summary every morning at 8am (${userTimezone || "your timezone"})`,
    "- Individual reminders at each scheduled dose time",
    "",
    `To stop reminders at any time, open the app and click "Stop reminders".`,
  ].filter(l => l !== null).join("\n");
}

// ─── HTML email builder ───────────────────────────────────────────────────────

/**
 * Build the branded HTML email. The session and unsubscribe links are signed
 * with `config.secret` and rooted at `config.appUrl`.
 *
 * @param {object} params  message content (type, dose, doses, medications, ...)
 * @param {{ appUrl: string, secret?: string }} config
 */
function buildHtmlEmail({ type, bodyText, dose, doses, medications, dosesScheduled, userTimezone, userId }, config = {}) {
  // ── Inner content varies by message type ──────────────────────────────────

  const sessionUrl     = buildSessionUrl(userId, config);
  const unsubscribeUrl = buildUnsubscribeUrl(userId, config);

  let bodyContent;

  if (type === "subscribed") {
    const meds = medications || [];
    const medItems = meds.length > 0
      ? meds.map(m => {
          const name    = m.name || m.medication || "Unknown";
          const doseInfo = m.dose_mg ? ` &middot; ${m.dose_mg}mg` : "";
          const form     = m.form    ? ` (${m.form})`              : "";
          return `<li style="padding:5px 0;font-size:14px;color:#333;">${name}${form}${doseInfo}</li>`;
        }).join("")
      : `<li style="padding:5px 0;font-size:14px;color:#888;">No medications listed</li>`;

    bodyContent = `
      <p style="margin:0 0 16px;font-size:32px;line-height:1;">🔔</p>
      <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1b1b1b;">You're subscribed!</p>
      <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">Medication reminders have been set up for the following:</p>
      <ul style="margin:0 0 24px;padding-left:20px;">${medItems}</ul>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
        <tr>
          <td style="background:#f0f7f4;border-radius:8px;padding:18px 20px;">
            <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.6px;">What to expect</p>
            <p style="margin:0 0 8px;font-size:14px;color:#333;">📅 Daily summary — every morning at 8am (${userTimezone || "your timezone"})</p>
            <p style="margin:0;font-size:14px;color:#333;">💊 ${dosesScheduled || 0} dose reminder(s) — sent at each scheduled time</p>
          </td>
        </tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr>
          <td align="center">
            <a href="${sessionUrl}" style="display:inline-block;background:#2d6a4f;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:8px;">
              View my schedule &amp; ask a question
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">Use the button above any time to reopen your schedule and chat about your meds — no login needed. To stop reminders, open the app and click <strong>Stop reminders</strong>.</p>`;

  } else if (type === "test") {
    bodyContent = `
      <p style="margin:0 0 16px;font-size:32px;line-height:1;">✅</p>
      <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1b1b1b;">You're all set!</p>
      <p style="margin:0;font-size:15px;color:#555;line-height:1.7;">
        Your email medication reminders are working correctly.<br>
        Future dose reminders will be delivered to this address.
      </p>`;

  } else if (type === "daily_summary" && doses && doses.length > 0) {
    const rows = doses.map((d) => {
      const medName = d.brand ? `${d.brand} <span style="color:#999;font-weight:400;">(${d.medication})</span>` : d.medication;
      const detail = `${d.amount} ${d.unit}${d.notes ? " &middot; " + d.notes : ""}`;
      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #f0f0f0;vertical-align:middle;">
            <p style="margin:0;font-size:15px;font-weight:600;color:#1b1b1b;">${medName}</p>
            <p style="margin:3px 0 0;font-size:13px;color:#888;">${detail}</p>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:middle;white-space:nowrap;">
            <span style="display:inline-block;background:#edf7f2;color:#2d6a4f;font-size:13px;font-weight:700;padding:5px 14px;border-radius:20px;">${d.time}</span>
          </td>
        </tr>`;
    }).join("");

    bodyContent = `
      <p style="margin:0 0 4px;font-size:20px;font-weight:700;color:#1b1b1b;">Good morning! 👋</p>
      <p style="margin:0 0 24px;font-size:14px;color:#666;">Here are your medications scheduled for today:</p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
      <p style="margin:28px 0 0;font-size:14px;color:#888;text-align:center;">Stay healthy 💊</p>`;

  } else if (dose) {
    const medName = dose.brand
      ? `${dose.medication} <span style="font-size:15px;font-weight:400;color:#666;">(${dose.brand})</span>`
      : dose.medication;
    const amount   = `${dose.amount} ${dose.unit}`;
    const instr    = dose.instruction || "";
    const notes    = dose.notes || "";
    const special  = dose.special_instructions || "";

    const notesHtml   = notes   ? `<p style="margin:10px 0 0;font-size:13px;color:#777;">${notes}</p>` : "";
    const specialHtml = special ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
        <tr>
          <td style="background:#fff8e1;border-radius:8px;padding:14px 18px;">
            <p style="margin:0;font-size:13px;color:#7a6200;line-height:1.6;">⚠️ ${special}</p>
          </td>
        </tr>
      </table>` : "";

    bodyContent = `
      <p style="margin:0 0 20px;font-size:12px;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.8px;">Time to take your medication</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;">
        <tr>
          <td style="background:#f0f7f4;border-left:4px solid #2d6a4f;border-radius:0 8px 8px 0;padding:20px 24px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1b1b1b;">${medName}</p>
            <p style="margin:0;font-size:16px;font-weight:600;color:#2d6a4f;">${amount}${instr ? " &middot; " + instr : ""}</p>
            ${notesHtml}
          </td>
        </tr>
      </table>
      ${specialHtml}`;

  } else {
    // Fallback: render plain text in a clean block
    bodyContent = `<p style="margin:0;font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${bodyText}</p>`;
  }

  // ── Shared wrapper ────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RxReader</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f5f2;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">

          <!-- Header -->
          <tr>
            <td style="background-color:#2d6a4f;border-radius:12px 12px 0 0;padding:28px 36px;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">RxReader</p>
              <p style="margin:5px 0 0;font-size:13px;color:rgba(255,255,255,0.65);">Medication Reminder</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:36px;">
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9faf9;border-top:1px solid #eaeaea;border-radius:0 0 12px 12px;padding:20px 36px;">
              <p style="margin:0 0 6px;font-size:12px;color:#aaa;line-height:1.6;">
                This is an automated medication reminder from RxReader. Do not reply to this email.
              </p>
              ${unsubscribeUrl ? `<p style="margin:0;font-size:12px;line-height:1.6;">
                <a href="${unsubscribeUrl}" style="color:#2d6a4f;text-decoration:underline;">Unsubscribe</a>
                <span style="color:#ccc;"> &middot; </span>
                <a href="${sessionUrl}" style="color:#aaa;text-decoration:none;">Open my schedule</a>
              </p>` : ""}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  TOKEN_TTL_SECONDS,
  signSessionToken,
  buildSessionUrl,
  buildUnsubscribeUrl,
  formatDoseMessage,
  formatDailySummaryMessage,
  formatTestMessage,
  formatSubscribedMessage,
  buildHtmlEmail,
};
