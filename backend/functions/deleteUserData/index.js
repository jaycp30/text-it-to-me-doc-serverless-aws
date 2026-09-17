"use strict";

/**
 * deleteUserData/index.js
 *
 * DELETE /data/{userId}?token=<signed-session-token>
 *
 * Right-to-erasure endpoint (GDPR Art. 17). Walks every store that holds
 * anything about a user and empties it:
 *
 *   EventBridge Scheduler  upcoming reminder rules (target payload embeds contact info)
 *   S3                     prescription images under <userId>/prescriptions/
 *   DynamoDB rx-schedules  contact info, full prescription JSON, medications
 *   DynamoDB rx-prescriptions  extracted medication JSON, image keys
 *
 * This is deliberately NOT the same endpoint as DELETE /reminders/{userId}.
 * That one is "stop reminders" — reversible, and the restore flow depends on the
 * records surviving. This one is irreversible. Keeping them apart also keeps
 * s3:DeleteObject off the cancel path, which is reachable one click from every
 * email we send.
 *
 * ORDER MATTERS. Scheduler rules first (stops new sends), then S3, then DynamoDB
 * last. The DynamoDB rows are the index of what exists; deleting them first would
 * mean a later failure leaves prescription images in S3 that nothing can find.
 * Deleting the index last makes the whole operation safely retryable.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { SchedulerClient, DeleteScheduleCommand } = require("@aws-sdk/client-scheduler");
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

// One implementation of the auth primitive, shipped as a layer. See
// backend/layers/auth/nodejs/node_modules/rx-session-token/.
const { verifySessionToken } = require("rx-session-token");
// Scheduling/batching helpers stay in this function's own lib.
const {
  collectRuleNames,
  imagePrefixFor,
  chunk,
  toDeleteRequests,
  isDeleteHandled,
  collectFailures,
} = require("./lib");

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const scheduler = new SchedulerClient({});
const s3        = new S3Client({});

const SCHEDULES_TABLE     = process.env.SCHEDULES_TABLE;
const PRESCRIPTIONS_TABLE = process.env.PRESCRIPTIONS_TABLE;
const IMAGES_BUCKET       = process.env.IMAGES_BUCKET;
const SCHEDULER_GROUP     = process.env.SCHEDULER_GROUP;
const MAGIC_LINK_SECRET   = process.env.MAGIC_LINK_SECRET || "";
const APP_URL             = process.env.APP_URL || "";

// Scoped to the app origin rather than "*". The HttpApi itself is already locked
// to AppUrl; a wildcard here would only widen what this specific handler accepts.
//
// With no APP_URL the header is omitted entirely rather than sent as "null" —
// "null" is a real origin a browser will match (sandboxed iframes, some
// redirect and data: contexts), so it fails open where omitting fails closed.
const HEADERS = {
  "Content-Type": "application/json",
  ...(APP_URL ? { "Access-Control-Allow-Origin": APP_URL } : {}),
};

// AWS hard caps, not tuning knobs: over either limit the whole request is rejected.
const S3_DELETE_BATCH   = 1000;
const DYNAMO_WRITE_BATCH = 25;

module.exports.handler = async (event) => {
  try {
    const token = event.queryStringParameters?.token;

    // Identity comes from the token; the {userId} path parameter is ignored, as
    // on DELETE /reminders/{userId}. Requiring the two to match could only ever
    // manufacture false 401s — a magic link opened on a device that has never
    // uploaded holds a valid token but has no cached id of its own. The path
    // parameter stays for URL shape and logging.
    const userId = verifySessionToken(token, MAGIC_LINK_SECRET);
    if (!userId) {
      return respond(401, {
        error: "Invalid or expired session token. Please use a recent email link.",
      });
    }

    // 1. Read the index first. Both queries are paginated: a user on a long
    //    course of several medications accumulates more than one page of rows,
    //    and a silently truncated read here would leave data behind while
    //    reporting success.
    const schedules    = await queryAll(SCHEDULES_TABLE, userId);
    const prescriptions = await queryAll(PRESCRIPTIONS_TABLE, userId);

    const failures = [];

    // 2. Scheduler rules. Done before anything else so no further reminder can
    //    fire mid-erasure and write fresh contact details into the logs.
    const ruleNames = collectRuleNames(schedules);
    const ruleResults = await Promise.allSettled(
      ruleNames.map((name) =>
        scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: SCHEDULER_GROUP }))
      )
    );
    failures.push(...collectFailures(ruleResults).map((m) => `scheduler: ${m}`));
    const rulesDeleted = ruleResults.filter(isDeleteHandled).length;

    // 3. S3 images, enumerated by prefix rather than from the imageKeys stored in
    //    DynamoDB. An upload that never reached /process has an S3 object and no
    //    row at all, so trusting the index would silently orphan it forever.
    const { deleted: imagesDeleted, errors: s3Errors } = await deleteImages(userId);
    failures.push(...s3Errors.map((m) => `s3: ${m}`));

    // 4. DynamoDB last — see the ORDER MATTERS note at the top of this file.
    const scheduleRows = await deleteRows(SCHEDULES_TABLE, schedules, ["userId", "scheduleId"]);
    const prescriptionRows = await deleteRows(PRESCRIPTIONS_TABLE, prescriptions, ["userId", "prescriptionId"]);
    failures.push(...scheduleRows.errors.map((m) => `rx-schedules: ${m}`));
    failures.push(...prescriptionRows.errors.map((m) => `rx-prescriptions: ${m}`));

    const counts = {
      reminders:     rulesDeleted,
      images:        imagesDeleted,
      schedules:     scheduleRows.deleted,
      prescriptions: prescriptionRows.deleted,
    };

    // The audit trail for the erasure is this line and nothing more. A permanent
    // "user X was erased" row would mean retaining an identifier in order to
    // prove we stopped retaining identifiers; the log group expires at 30 days.
    // Counts only — never the contact details or medications being deleted.
    if (failures.length > 0) {
      console.error(`[${userId}] Erasure incomplete:`, failures.join("; "), counts);
      return respond(500, {
        ok: false,
        counts,
        // Deliberately does not claim nothing was deleted — a partial erasure
        // really did remove some of it. Retrying is safe because the DynamoDB
        // index is deleted last, so a second call re-enumerates what is left.
        error: "Some of your data could not be deleted. Please try again — it is "
             + "safe to repeat, and will remove whatever is left.",
      });
    }

    console.log(`[${userId}] Erasure complete:`, JSON.stringify(counts));

    return respond(200, {
      ok: true,
      counts,
      message: "All of your data has been deleted.",
    });

  } catch (error) {
    // Reached when an enumeration call throws (queryAll, or the ListObjectsV2
    // inside deleteImages) rather than returning a per-item failure. Scheduler
    // rules may already be gone at this point, so the wording matches the
    // partial-failure branch above: safe to retry, and it will finish the job.
    console.error("deleteUserData error:", error);
    return respond(500, {
      ok: false,
      error: "Some of your data could not be deleted. Please try again — it is "
           + "safe to repeat, and will remove whatever is left.",
    });
  }
};

function respond(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

/**
 * Query every item for a user, following LastEvaluatedKey to the end.
 * No FilterExpression: erasure takes cancelled and inactive records too.
 */
async function queryAll(tableName, userId) {
  const items = [];
  let startKey;

  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": userId },
      ExclusiveStartKey: startKey,
    }));
    items.push(...(result.Items || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return items;
}

/**
 * List and delete every object under the user's prescription prefix.
 * Returns how many keys were deleted plus any per-key errors DeleteObjects
 * reported — those come back in the response body, not as a thrown error, so
 * they are easy to miss.
 */
async function deleteImages(userId) {
  const prefix = imagePrefixFor(userId);
  const keys = [];
  let continuationToken;

  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: IMAGES_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    keys.push(...(listed.Contents || []).map((object) => ({ Key: object.Key })));
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  if (keys.length === 0) return { deleted: 0, errors: [] };

  let deleted = 0;
  const errors = [];

  for (const batch of chunk(keys, S3_DELETE_BATCH)) {
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: IMAGES_BUCKET,
      Delete: { Objects: batch, Quiet: true },
    }));
    // Quiet mode returns only failures, so Deleted is absent on full success.
    errors.push(...(result.Errors || []).map((e) => `${e.Key}: ${e.Message}`));
    deleted += batch.length - (result.Errors || []).length;
  }

  return { deleted, errors };
}

/**
 * Delete every queried row from one table in batches of 25.
 *
 * BatchWriteItem can partially succeed: items it declined come back in
 * UnprocessedItems with a 200 status. Not re-sending those is the classic way to
 * leave rows behind while believing the delete worked, so each batch is retried
 * with backoff before it is reported as a failure.
 */
async function deleteRows(tableName, items, keyNames) {
  const requests = toDeleteRequests(items, keyNames);
  if (requests.length === 0) return { deleted: 0, errors: [] };

  let deleted = 0;
  const errors = [];

  for (const batch of chunk(requests, DYNAMO_WRITE_BATCH)) {
    let pending = batch;
    let attempt = 0;

    while (pending.length > 0 && attempt < 4) {
      try {
        const result = await dynamo.send(new BatchWriteCommand({
          RequestItems: { [tableName]: pending },
        }));
        const unprocessed = result.UnprocessedItems?.[tableName] || [];
        deleted += pending.length - unprocessed.length;
        pending = unprocessed;
        if (pending.length > 0) {
          attempt += 1;
          await sleep(100 * 2 ** attempt);   // 200ms, 400ms, 800ms
        }
      } catch (error) {
        errors.push(error.message);
        pending = [];
      }
    }

    if (pending.length > 0) {
      errors.push(`${pending.length} row(s) still unprocessed after retries`);
    }
  }

  return { deleted, errors };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
