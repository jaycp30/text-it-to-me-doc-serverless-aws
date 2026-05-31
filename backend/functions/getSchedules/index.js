"use strict";

/**
 * getSchedules/index.js
 *
 * Returns medication schedules for the authenticated user.
 * By default the frontend receives only active schedules for the timetable.
 * Restore links can pass includeInactive=true to show a friendly cancelled state.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    // userId comes from Cognito JWT via API Gateway authorizer
    // For now we're reading it from query params — lock this down with
    // a Cognito authorizer on the API Gateway after first deploy
    const userId = event.queryStringParameters?.userId;
    const includeInactive = event.queryStringParameters?.includeInactive === "true";

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "userId required" }) };
    }

    const query = {
      TableName: SCHEDULES_TABLE,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: {
        ":uid": userId,
      },
    };

    if (!includeInactive) {
      query.FilterExpression = "#active = :true";
      query.ExpressionAttributeNames = { "#active": "active" };
      query.ExpressionAttributeValues[":true"] = true;
    }

    const result = await dynamo.send(new QueryCommand(query));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        schedules: result.Items || [],
        count: result.Count || 0,
      }),
    };

  } catch (error) {
    console.error("getSchedules error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
