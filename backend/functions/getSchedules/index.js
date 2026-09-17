"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
// One implementation of the auth primitive, shipped as a layer. See
// backend/layers/auth/nodejs/node_modules/rx-session-token/.
const { verifySessionToken } = require("rx-session-token");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const params = event.queryStringParameters || {};
    const token = params.token;
    const includeInactive = params.includeInactive === "true";

    const userId = verifySessionToken(token, MAGIC_LINK_SECRET);

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Invalid or expired session link. Please use a recent email link or re-upload your prescription." }),
      };
    }

    const query = {
      TableName: SCHEDULES_TABLE,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": userId },
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
