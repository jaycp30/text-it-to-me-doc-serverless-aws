"use strict";

/**
 * dailySummary/index.js
 *
 * Option B — runs every hour via EventBridge cron.
 * For each active user schedule, checks if it's currently 8am in their timezone.
 * If so, compiles today's medications and invokes NotifyUser.
 *
 * Why hourly instead of once? Users have different timezones.
 * A global cron at midnight UTC would be wrong for Manila (UTC+8), London, etc.
 * Checking every hour means we catch 8am in every timezone within 1 hour.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { DateTime } = require("luxon");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;
const NOTIFIER_FUNCTION_ARN = process.env.NOTIFIER_FUNCTION_ARN;

/**
 * Check if it's currently between 8:00am and 8:59am in the given timezone.
 * This is our "morning summary window."
 */
function isMorningNow(timezone) {
  const now = DateTime.now().setZone(timezone);
  return now.hour === 8;
}

/**
 * Get all doses scheduled for today in the given timezone.
 */
function getTodaysDoses(scheduledDoses, timezone) {
  const today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");

  return scheduledDoses
    .filter((dose) => dose.date === today)
    .sort((a, b) => a.time.localeCompare(b.time)); // sort by time
}

/**
 * Invoke the NotifyUser Lambda asynchronously.
 */
async function invokeNotifier(payload) {
  const command = new InvokeCommand({
    FunctionName: NOTIFIER_FUNCTION_ARN,
    InvocationType: "Event", // async — don't wait for response
    Payload: JSON.stringify(payload),
  });
  await lambda.send(command);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports.handler = async () => {
  console.log("DailySummary running at:", new Date().toISOString());

  // Scan all active schedules
  // Note: For large scale (thousands of users), replace with a GSI query.
  // For personal + friends use, a full scan is fine and cheaper.
  let schedules = [];
  let lastKey;

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: SCHEDULES_TABLE,
      FilterExpression: "#active = :true",
      ExpressionAttributeNames: { "#active": "active" },
      ExpressionAttributeValues: { ":true": true },
      ExclusiveStartKey: lastKey,
    }));

    schedules = schedules.concat(result.Items || []);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Found ${schedules.length} active schedules`);

  let notificationsSent = 0;

  for (const schedule of schedules) {
    const timezone = schedule.userTimezone || "Asia/Manila";

    // Only notify users for whom it's currently 8am
    if (!isMorningNow(timezone)) continue;

    const todaysDoses = getTodaysDoses(schedule.scheduledDoses || [], timezone);

    if (todaysDoses.length === 0) {
      console.log(`[${schedule.userId}] No doses today in ${timezone}`);
      continue;
    }

    console.log(`[${schedule.userId}] Sending daily summary: ${todaysDoses.length} doses`);

    await invokeNotifier({
      userId: schedule.userId,
      notificationMethod: schedule.notificationMethod,
      contactInfo: schedule.contactInfo,
      type: "daily_summary",
      doses: todaysDoses,
    });

    notificationsSent++;
  }

  console.log(`DailySummary complete — sent ${notificationsSent} summaries`);
  return { notificationsSent };
};
