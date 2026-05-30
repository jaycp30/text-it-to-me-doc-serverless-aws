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

// ─── Message formatters ───────────────────────────────────────────────────────

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

async function sendEmail(emailAddress, subject, bodyText) {
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
          Data: bodyText,
          Charset: "UTF-8",
        },
        // Simple HTML version for email clients
        Html: {
          Data: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #2d6a4f; margin-bottom: 16px;">RxReader</h2>
              <pre style="white-space: pre-wrap; font-family: inherit; color: #1b1b1b; line-height: 1.6;">${bodyText}</pre>
              <p style="color: #888; font-size: 12px; margin-top: 24px;">
                This is an automated medication reminder. Do not reply to this email.
              </p>
            </div>
          `,
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
      await sendEmail(contactInfo, subject, message);
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
