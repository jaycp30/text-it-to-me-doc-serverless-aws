"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
// One implementation of the auth primitive, shipped as a layer. See
// backend/layers/auth/nodejs/node_modules/rx-session-token/.
const { verifySessionToken } = require("rx-session-token");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

// Scoped to the app origin rather than "*". The HttpApi's own CorsConfiguration
// is already locked to AppUrl, but these per-response headers are what a browser
// actually reads, so a wildcard here quietly widens what the template claims.
//
// Omitted entirely when APP_URL is unset rather than sent as "null": "null" is a
// real origin a browser will match (sandboxed iframes, some redirect and data:
// contexts), so it fails open where omitting fails closed.
const APP_URL = process.env.APP_URL || "";

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    ...(APP_URL ? { "Access-Control-Allow-Origin": APP_URL } : {}),
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
