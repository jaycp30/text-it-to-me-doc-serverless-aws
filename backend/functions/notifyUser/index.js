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
const { randomUUID } = require("crypto");

// Pure message + HTML-email builders live in email.js so they can be
// unit-tested without SNS/SES. See backend/tests/email.test.js.
const {
  formatDoseMessage,
  formatDailySummaryMessage,
  formatTestMessage,
  formatSubscribedMessage,
  buildHtmlEmail,
} = require("./email");

const sns = new SNSClient({});
const ses = new SESClient({});

const SES_FROM_EMAIL       = process.env.SES_FROM_EMAIL       || "noreply@rxreader.app";
const APP_URL              = process.env.APP_URL              || "https://main.d3bj6u7583ielg.amplifyapp.com";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const MAGIC_LINK_SECRET    = process.env.MAGIC_LINK_SECRET    || "";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

function getRequestIp(event) {
  return event?.requestContext?.http?.sourceIp ||
    event?.headers?.["cf-connecting-ip"] ||
    event?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    undefined;
}

async function verifyTurnstileToken(token, remoteip) {
  if (!TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not configured");
    return { success: false, "error-codes": ["missing-secret"] };
  }

  if (!token || String(token).length > 2048) {
    return { success: false, "error-codes": ["missing-input-response"] };
  }

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
        remoteip,
        idempotency_key: randomUUID(),
      }),
    });

    if (!res.ok) {
      console.error(`Turnstile verification HTTP ${res.status}`);
      return { success: false, "error-codes": ["siteverify-http-error"] };
    }

    return await res.json();
  } catch (error) {
    console.error("Turnstile verification error:", error);
    return { success: false, "error-codes": ["siteverify-request-error"] };
  }
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

async function sendEmail(emailAddress, subject, bodyText, emailData = {}, userId = "") {
  const htmlBody = buildHtmlEmail(
    { bodyText, userId, ...emailData },
    { appUrl: APP_URL, secret: MAGIC_LINK_SECRET },
  );

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
      type,               // "dose" | "daily_summary" | "test" | "subscribed"
      turnstileToken,     // Cloudflare Turnstile token for public test sends
      medications,        // array of medication objects (subscribed confirmation)
      dosesScheduled,     // number of scheduled doses (subscribed confirmation)
      userTimezone,       // IANA timezone string (subscribed confirmation)
    } = payload;

    if (http && type === "test") {
      const validation = await verifyTurnstileToken(turnstileToken, getRequestIp(event));
      if (!validation.success) {
        console.warn("Turnstile verification failed:", validation["error-codes"]);
        return response(403, {
          error: "Human verification failed. Please try again.",
        }, http);
      }
    }

    if (!contactInfo) {
      console.error("No contactInfo provided — cannot send notification");
      return response(400, { error: "contactInfo required" }, http);
    }

    const isSMS = notificationMethod === "sms";
    const isDailySummary = type === "daily_summary" || (doses && doses.length > 0);

    let message, subject;

    if (type === "subscribed") {
      message = formatSubscribedMessage({ medications, dosesScheduled, userTimezone });
      subject = "You're subscribed to RxReader reminders";
    } else if (type === "test") {
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
      await sendEmail(contactInfo, subject, message, { type, dose, doses, medications, dosesScheduled, userTimezone }, userId);
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
