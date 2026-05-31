"use strict";

/**
 * notifyUser/index.js
 *
 * Invoked two ways:
 *   1. EventBridge Scheduler (Option A) — fires at exact dose time
 *   2. DailySummary Lambda (Option B) — called internally with today's doses
 *
 * Sends either SMS (SNS direct publish) or email (SES).
 */

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const sns = new SNSClient({});
const ses = new SESClient({});

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || "noreply@rxreader.app";

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function isHttpEvent(event) {
  return Boolean(event?.requestContext?.http);
}

function response(statusCode, payload, http = true) {
  if (!http) return { statusCode, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
  return {
    statusCode,
    headers: RESPONSE_HEADERS,
    body: JSON.stringify(payload),
  };
}

function getPayload(event) {
  if (!isHttpEvent(event)) return event;
  return JSON.parse(event.body || "{}");
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

// ─── HTML email builder ───────────────────────────────────────────────────────

function buildHtmlEmail({ type, bodyText, dose, doses }) {
  // ── Inner content varies by message type ──────────────────────────────────

  let bodyContent;

  if (type === "test") {
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
              <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">
                This is an automated medication reminder from RxReader. Do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Send functions ───────────────────────────────────────────────────────────

async function sendSMS(phoneNumber, message) {
  // SNS direct publish to phone number (no topic needed)
  // Phone number must be in E.164 format: +639XXXXXXXXX
  const command = new PublishCommand({
    PhoneNumber: phoneNumber,
    Message: message,
    MessageAttributes: {
      "AWS.SNS.SMS.SMSType": {
        DataType: "String",
        StringValue: "Transactional", // higher delivery priority than Promotional
      },
      "AWS.SNS.SMS.SenderID": {
        DataType: "String",
        StringValue: "RxReader", // shown as sender name on some carriers
      },
    },
  });

  await sns.send(command);
  console.log(`SMS sent to ${phoneNumber.substring(0, 6)}****`); // partial log for privacy
}

async function sendEmail(emailAddress, subject, bodyText, emailData = {}) {
  const htmlBody = buildHtmlEmail({ bodyText, ...emailData });

  const command = new SendEmailCommand({
    Source: SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [emailAddress],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: bodyText, // plain-text fallback for clients that don't render HTML
          Charset: "UTF-8",
        },
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
      },
    },
  });

  await ses.send(command);
  console.log(`Email sent to ${emailAddress.split("@")[0]}@****`);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports.handler = async (event) => {
  console.log("NotifyUser event:", JSON.stringify(event, null, 2));
  const http = isHttpEvent(event);

  try {
    const payload = getPayload(event);
    const {
      userId,
      notificationMethod, // "sms" | "email"
      contactInfo,        // phone number or email
      dose,               // single dose object (Option A)
      doses,              // array of dose objects (Option B daily summary)
      type,               // "dose" | "daily_summary" | "test"
    } = payload;

    if (!contactInfo) {
      console.error("No contactInfo provided — cannot send notification");
      return response(400, { error: "contactInfo required" }, http);
    }

    const isSMS = notificationMethod === "sms";
    const isDailySummary = type === "daily_summary" || (doses && doses.length > 0);

    let message, subject;

    if (type === "test") {
      message = formatTestMessage(notificationMethod);
      subject = "Test medication reminder — RxReader";
    } else if (isDailySummary) {
      message = formatDailySummaryMessage(doses);
      subject = "Your medications for today — RxReader";
    } else if (dose) {
      message = formatDoseMessage(dose);
      subject = `Medication reminder: ${dose.medication}`;
    } else {
      console.error("No dose or doses provided");
      return response(400, { error: "dose or doses required" }, http);
    }

    if (isSMS) {
      await sendSMS(contactInfo, message);
    } else {
      // Pass structured data so buildHtmlEmail can render a richer template
      await sendEmail(contactInfo, subject, message, { type, dose, doses });
    }

    console.log(`[${userId}] Notification sent via ${notificationMethod}`);
    return response(200, {
      ok: true,
      message: type === "test" ? `Test ${notificationMethod || "email"} sent` : "Notification sent",
    }, http);

  } catch (error) {
    console.error("Notification error:", error);
    // Don't throw — EventBridge will retry if we return an error,
    // which could spam the user. Log and move on.
    return response(500, { error: error.message }, http);
  }
};
