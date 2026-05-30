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

    // 2. Delete each EventBridge Scheduler rule by its stored name
    let cancelledCount = 0;

    for (const schedule of schedules) {
      for (const dose of schedule.scheduledDoses || []) {
        if (!dose.scheduleName) continue;

        try {
          await scheduler.send(new DeleteScheduleCommand({
            Name: dose.scheduleName,
            GroupName: SCHEDULER_GROUP,
          }));
          cancelledCount++;
        } catch (err) {
          // Already fired and auto-deleted — that's fine
          if (err.name !== "ResourceNotFoundException") {
            console.error(`Failed to delete schedule ${dose.scheduleName}:`, err.message);
          }
        }
      }

      // 3. Mark the DynamoDB record inactive so DailySummary skips this user
      await dynamo.send(new UpdateCommand({
        TableName: SCHEDULES_TABLE,
        Key: { userId: schedule.userId, scheduleId: schedule.scheduleId },
        UpdateExpression: "SET #active = :false",
        ExpressionAttributeNames: { "#active": "active" },
        ExpressionAttributeValues: { ":false": false },
      }));
    }

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
