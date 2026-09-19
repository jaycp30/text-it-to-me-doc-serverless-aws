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

// No hardcoded fallbacks for either of these. Both are required configuration
// that must match external state this code cannot see -- SES_FROM_EMAIL has to
// be an identity verified in SES, and APP_URL has to be the origin the API's
// CORS actually allows. Guessing a value hides a deployment fault behind emails
// that look fine, so sendEmail refuses instead (#43, #45).
const SES_FROM_EMAIL       = process.env.SES_FROM_EMAIL || "";
const APP_URL              = process.env.APP_URL || "";
// The address users can write to about their data or to report a problem (#28).
// Unlike SES_FROM_EMAIL and APP_URL this is NOT required to send: if it is
// missing the footer simply omits the line. Refusing to send a medication
// reminder because a contact line is unconfigured would be the wrong trade --
// the reminder is the point, the contact line is an addition to it.
const CONTACT_EMAIL        = process.env.CONTACT_EMAIL || "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const MAGIC_LINK_SECRET    = process.env.MAGIC_LINK_SECRET    || "";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  ...(APP_URL ? { "Access-Control-Allow-Origin": APP_URL } : {}),
};

// SECURITY-CRITICAL. Two protections below key off this: Turnstile only runs
// when it is true, and the footer links are only suppressed when it is true.
// `requestContext.http` exists because RxApi is an AWS::Serverless::HttpApi
// (payload format v2). Converting it to a REST AWS::Serverless::Api would
// remove that field, make this return false for real public requests, and
// silently switch BOTH protections off with no test or deploy failure.
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

// Only an HTTP invocation carries a body to parse; Scheduler, worker and
// dailySummary invocations hand over an object directly and cannot throw here.
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
  // Refuse rather than guess. Sending from an unverified identity is rejected by
  // SES anyway; building links against a wrong origin is worse, because the mail
  // goes out looking correct and only fails later in the recipient's browser.
  //
  // Deliberately here and not at handler start: an SMS reminder needs neither
  // value, and a missing email config must not take out SMS delivery too.
  //
  // Throwing lands in the handler's catch, which logs and returns without
  // rethrowing -- that is intentional, so EventBridge does not retry and spam
  // the user with a fault no retry can fix.
  const missing = [
    !SES_FROM_EMAIL && "SES_FROM_EMAIL",
    !APP_URL && "APP_URL",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Cannot send email: ${missing.join(" and ")} not configured`);
  }

  const htmlBody = buildHtmlEmail(
    { bodyText, userId, ...emailData },
    { appUrl: APP_URL, secret: MAGIC_LINK_SECRET, contactEmail: CONTACT_EMAIL },
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
  const http = isHttpEvent(event);
  // Never log the raw event. On a scheduler invocation it carries contactInfo
  // (the raw email or phone number) and the medication name — which would undo
  // the deliberate masking in sendSms/sendEmail below. Log the shape only.
  console.log(`NotifyUser invoked via ${http ? "http" : "scheduler"}`);

  // Parsed before the main try: inside it a malformed body would hit the
  // catch-all and return 500, blaming the server for the caller's bad request.
  let payload;
  try {
    payload = getPayload(event);
  } catch {
    return response(400, { error: "Request body is not valid JSON.", code: "MALFORMED_JSON" }, http);
  }

  try {
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

    // Human verification gates EVERY public HTTP invocation, not just the ones
    // that call themselves "test". `type` comes from the request body, so gating
    // on `type === "test"` meant an attacker sent `type: "subscribed"` and
    // skipped the check entirely — while still reaching the SES/SNS send below.
    if (http) {
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

    // A public HTTP caller can only ever send the fixed test message. `type`
    // came from the request body and chose the formatter, so `type: "dose"` with
    // a crafted dose object put attacker-written text through formatDoseMessage
    // to any phone number or inbox on earth — an open SES/SNS relay on our bill
    // and our sender reputation. The route is /notify-test; this makes it so.
    const effectiveType = http ? "test" : type;

    const isSMS = notificationMethod === "sms";
    const isDailySummary = effectiveType === "daily_summary" || (!http && doses && doses.length > 0);

    let message, subject;

    if (effectiveType === "subscribed") {
      message = formatSubscribedMessage({ medications, dosesScheduled, userTimezone });
      subject = "You're subscribed to RxReader reminders";
    } else if (effectiveType === "test") {
      message = formatTestMessage(notificationMethod);
      subject = "Test medication reminder — RxReader";
    } else if (isDailySummary) {
      message = formatDailySummaryMessage(doses);
      subject = "Your medications for today — RxReader";
    } else if (!http && dose) {
      message = formatDoseMessage(dose);
      subject = `Medication reminder: ${dose.medication}`;
    } else {
      console.error("No dose or doses provided");
      return response(400, { error: "dose or doses required" }, http);
    }

    if (isSMS) {
      await sendSMS(contactInfo, message);
    } else {
      // Pass structured data so buildHtmlEmail can render a richer template.
      //
      // linkUserId is deliberately NOT the caller's userId on an HTTP call. The
      // footer links (open my schedule / unsubscribe / delete my data) are all
      // signed for whatever userId is passed here, and on a public HTTP route
      // both the userId and the destination address come from the request body.
      // That let anyone POST {userId: "<victim>", contactInfo: "<attacker>"} and
      // be mailed working, indefinitely-renewable credentials for that user.
      //
      // Scheduler, worker and dailySummary invocations keep their userId,
      // because there the destination comes from the stored record rather than
      // from the caller — the links can only reach the person they belong to.
      // A test send addressed to an arbitrary address needs no links at all.
      const linkUserId = http ? "" : userId;
      await sendEmail(contactInfo, subject, message, { type: effectiveType, dose, doses, medications, dosesScheduled, userTimezone }, linkUserId);
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
