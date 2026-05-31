"use strict";

/**
 * cancelReminders/index.js
 *
 * DELETE /reminders/{userId}
 *
 * Cancels all upcoming EventBridge Scheduler rules for a user and marks
 * their DynamoDB schedule records as inactive. Used for opt-out.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SchedulerClient, DeleteScheduleCommand } = require("@aws-sdk/client-scheduler");

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const scheduler = new SchedulerClient({});

const SCHEDULES_TABLE  = process.env.SCHEDULES_TABLE;
const SCHEDULER_GROUP  = process.env.SCHEDULER_GROUP;

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

module.exports.handler = async (event) => {
  try {
    const userId = event.pathParameters?.userId;

    if (!userId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "userId required" }) };
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
    const ruleNames = schedules.flatMap((schedule) =>
      (schedule.scheduledDoses || [])
        .map((dose) => dose.scheduleName)
        .filter(Boolean)
    );

    const deleteResults = await Promise.allSettled(
      ruleNames.map((name) =>
        scheduler.send(new DeleteScheduleCommand({
          Name: name,
          GroupName: SCHEDULER_GROUP,
        }))
      )
    );

    let cancelledCount = 0;
    deleteResults.forEach((result, i) => {
      if (result.status === "fulfilled") {
        cancelledCount++;
      } else if (result.reason?.name === "ResourceNotFoundException") {
        // Already fired and auto-deleted — that's fine, count it as handled
        cancelledCount++;
      } else {
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
          UpdateExpression: "SET #active = :false",
          ExpressionAttributeNames: { "#active": "active" },
          ExpressionAttributeValues: { ":false": false },
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
