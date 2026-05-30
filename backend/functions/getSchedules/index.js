"use strict";

/**
 * getSchedules/index.js
 *
 * Returns all active medication schedules for the authenticated user.
 * The frontend uses this to display the current timetable.
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

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "userId required" }) };
    }

    const result = await dynamo.send(new QueryCommand({
      TableName: SCHEDULES_TABLE,
      KeyConditionExpression: "userId = :uid",
      FilterExpression: "#active = :true",
      ExpressionAttributeNames: { "#active": "active" },
      ExpressionAttributeValues: {
        ":uid": userId,
        ":true": true,
      },
    }));

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
