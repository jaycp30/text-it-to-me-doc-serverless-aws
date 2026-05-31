"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { createHmac } = require("crypto");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

// ─── Session token verification ───────────────────────────────────────────────

function verifySessionToken(token) {
  if (!MAGIC_LINK_SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", MAGIC_LINK_SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.uid || !data.exp) return null;
    if (Math.floor(Date.now() / 1000) > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

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

    const userId = verifySessionToken(token);

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
