"use strict";

/**
 * cancelReminders/index.js
 *
 * DELETE /reminders/{userId}?token=<signed-session-token>
 *
 * Cancels all upcoming EventBridge Scheduler rules for a user and marks
 * their DynamoDB schedule records as inactive. Used for opt-out.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SchedulerClient, DeleteScheduleCommand } = require("@aws-sdk/client-scheduler");

// Pure helpers (idempotent cancel counting) live in lib.js so they can be
// unit-tested without AWS. See backend/tests/cancelReminders.test.js.
const { collectRuleNames, countCancelled } = require("./lib");
// One implementation of the auth primitive, shipped as a layer. See
// backend/layers/auth/nodejs/node_modules/rx-session-token/.
const { verifySessionToken } = require("rx-session-token");

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const scheduler = new SchedulerClient({});

const SCHEDULES_TABLE   = process.env.SCHEDULES_TABLE;
const SCHEDULER_GROUP   = process.env.SCHEDULER_GROUP;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

module.exports.handler = async (event) => {
  try {
    const token = event.queryStringParameters?.token;

    // Identity comes from the token, and the {userId} path parameter is ignored.
    // It used to have to match, which could only ever manufacture false 401s:
    // the token is the thing that proves anything, and a client that holds a
    // valid one but has not cached its own id — a magic link opened on a second
    // device — was told "please use a recent email link" while holding exactly
    // that. The path parameter stays in the route for URL shape and logging.
    const userId = verifySessionToken(token, MAGIC_LINK_SECRET);
    if (!userId) {
      return {
        statusCode: 401,
        headers: HEADERS,
        body: JSON.stringify({ error: "Invalid or expired session token. Please use a recent email link." }),
      };
    }

    // 1. Find all active schedule records for this user
    const result = await dynamo.send(new QueryCommand({
      TableName: SCHEDULES_TABLE,
      KeyConditionExpression: "userId = :uid",
      FilterExpression: "#active = :true",
      ExpressionAttributeNames: { "#active": "active" },
      ExpressionAttributeValues: { ":uid": userId, ":true": true },
    }));

    const schedules = result.Items || [];

    if (schedules.length === 0) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, cancelled: 0, message: "No active reminders found." }),
      };
    }

    // 2. Flatten every schedule rule name across all of the user's records,
    //    then delete them in parallel. A user with recurring meds can have
    //    dozens of rules; sequential deletes would add seconds and risk the
    //    API Gateway 30s timeout.
    const ruleNames = collectRuleNames(schedules);

    const deleteResults = await Promise.allSettled(
      ruleNames.map((name) =>
        scheduler.send(new DeleteScheduleCommand({
          Name: name,
          GroupName: SCHEDULER_GROUP,
        }))
      )
    );

    // Rules already fired-and-auto-deleted (ResourceNotFoundException) count as
    // handled — this is what makes a repeated unsubscribe idempotent.
    const cancelledCount = countCancelled(deleteResults);
    deleteResults.forEach((result, i) => {
      if (result.status === "rejected" && result.reason?.name !== "ResourceNotFoundException") {
        console.error(`Failed to delete schedule ${ruleNames[i]}:`, result.reason?.message);
      }
    });

    // 3. Mark every DynamoDB record inactive (in parallel) so DailySummary
    //    skips this user.
    await Promise.allSettled(
      schedules.map((schedule) =>
        dynamo.send(new UpdateCommand({
          TableName: SCHEDULES_TABLE,
          Key: { userId: schedule.userId, scheduleId: schedule.scheduleId },
          UpdateExpression: "SET #active = :false, #status = :cancelled, cancelledAt = :now, updatedAt = :now",
          ExpressionAttributeNames: {
            "#active": "active",
            "#status": "processingStatus",
          },
          ExpressionAttributeValues: {
            ":false": false,
            ":cancelled": "cancelled",
            ":now": new Date().toISOString(),
          },
        }))
      )
    );

    console.log(`[${userId}] Cancelled ${cancelledCount} reminder(s) across ${schedules.length} schedule(s)`);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        cancelled: cancelledCount,
        message: `Cancelled ${cancelledCount} upcoming reminder(s).`,
      }),
    };

  } catch (error) {
    console.error("cancelReminders error:", error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
