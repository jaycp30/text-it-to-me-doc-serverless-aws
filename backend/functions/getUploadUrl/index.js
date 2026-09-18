"use strict";

/**
 * getUploadUrl/index.js
 *
 * Returns a presigned S3 PUT URL so the frontend can upload
 * the prescription image directly to S3 without going through Lambda.
 *
 * This keeps Lambda fast (no image data passing through it) and
 * keeps API Gateway payload limits from being an issue.
 *
 * Flow:
 *   Frontend → POST /upload-url → gets { uploadUrl, imageKey, uploadId, userId?, sessionToken? }
 *   Frontend → PUT uploadUrl (with image bytes) → image in S3
 *   Frontend → POST /process { imageKeys, uploadId, sessionToken, ... } → processed
 *
 * THIS IS THE ONLY PLACE AN IDENTITY IS MINTED.
 *
 * It used to accept whatever `userId` the caller put in the body, and /process
 * would then sign a session token for that same unverified value — so anyone who
 * knew another user's id could mint a valid token for them and read, cancel or
 * delete their data. A signature only proves that *we* wrote the claim; it says
 * nothing about whether the claim was ever true.
 *
 * Now: present a valid session token and you are that user; present nothing and
 * you get a brand new server-generated identity. A `userId` in the request body
 * is ignored outright.
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");
const { newUserId, signSessionToken, verifySessionToken } = require("rx-session-token");

const s3 = new S3Client({});
const IMAGES_BUCKET = process.env.IMAGES_BUCKET;
const MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || "";

// Scoped to the app origin rather than "*". The HttpApi's own CorsConfiguration
// is already locked to AppUrl, but these per-response headers are what a browser
// actually reads, so a wildcard here quietly widens what the template claims.
//
// Omitted entirely when APP_URL is unset rather than sent as "null": "null" is a
// real origin a browser will match (sandboxed iframes, some redirect and data:
// contexts), so it fails open where omitting fails closed.
const APP_URL = process.env.APP_URL || "";

// Allowed image types
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const MAX_PAGE_NUMBER = 5;

function safeSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 120);
}

module.exports.handler = async (event, context) => {
  const headers = {
    "Content-Type": "application/json",
    ...(APP_URL ? { "Access-Control-Allow-Origin": APP_URL } : {}),
  };
  const requestId = context?.awsRequestId;

  // Parsed before the main try: inside it a malformed body would hit the
  // catch-all and return 500, blaming the server for the caller's bad request.
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Request body is not valid JSON.", code: "MALFORMED_JSON", requestId }),
    };
  }

  try {
    // Note the absence of `userId`. Anything the caller says about who they are
    // is ignored; identity comes from the signed token or is minted fresh below.
    const { sessionToken, contentType, uploadId, pageNumber } = body;

    if (!MAGIC_LINK_SECRET) {
      // Fail loudly rather than handing out an identity nobody can prove later.
      console.error("MAGIC_LINK_SECRET is not configured — cannot mint an identity");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Server is misconfigured. Please try again later.", code: "NO_SIGNING_SECRET", requestId }),
      };
    }

    // Returning user if they hold a valid token; otherwise a brand new identity.
    const existingUserId = verifySessionToken(sessionToken, MAGIC_LINK_SECRET);
    const userId = existingUserId || newUserId();
    // Only issued when an identity was just created. Re-issuing on every call
    // would let anyone holding a token extend it forever, turning a 90-day
    // credential into a permanent one.
    const issuedToken = existingUserId ? null : signSessionToken(userId, MAGIC_LINK_SECRET);

    const fileType = String(contentType || "image/jpeg").toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : String(contentType || "image/jpeg").toLowerCase();

    if (!ALLOWED_CONTENT_TYPES.includes(fileType)) {
      return {
        statusCode: 415,
        headers,
        body: JSON.stringify({ error: `That file type isn't supported. Use JPEG, PNG, or WebP.`, code: "UNSUPPORTED_FILE", detail: `Content type ${fileType} not allowed`, requestId }),
      };
    }

    const page = Number(pageNumber || 1);
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `pageNumber must be between 1 and ${MAX_PAGE_NUMBER}`, code: "INVALID_PAGE", requestId }),
      };
    }

    // Key format: userId/prescriptions/uploadId/page-N.ext
    // S3 "folders" are prefixes; grouping pages under uploadId keeps one
    // prescription's screenshots together for traceability.
    const ext = fileType.split("/")[1].replace("jpeg", "jpg");
    // userId goes in RAW, deliberately. It is either freshly minted by
    // newUserId() or came from a verified token, and verifySessionToken rejects
    // any uid outside USER_ID_PATTERN — so it is already safe as a key segment.
    //
    // Running it through safeSegment would be actively harmful: the two
    // disagree. safeSegment collapses repeated dashes and strips leading and
    // trailing ones, which the pattern allows, so `u--abc` would be WRITTEN
    // under `u-abc/` while /process and erasure look under `u--abc/` — and
    // `---` would collapse to an empty prefix entirely. That is exactly the
    // write-vs-search drift this endpoint has to avoid.
    //
    // uploadId keeps safeSegment: it is still client-supplied and unvalidated.
    const safeUploadId = safeSegment(uploadId) || `rx-upload-${randomUUID()}`;
    const imageKey = `${userId}/prescriptions/${safeUploadId}/page-${page}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: imageKey,
      ContentType: fileType,
    });

    // Presigned URL expires in 5 minutes — enough time for the upload
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        uploadUrl,
        imageKey,
        uploadId: safeUploadId,
        pageNumber: page,
        // The client stores these and sends the token on every later call. It
        // is the client's only source of identity — it no longer invents one.
        userId,
        ...(issuedToken ? { sessionToken: issuedToken } : {}),
      }),
    };

  } catch (error) {
    console.error("getUploadUrl error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not prepare the upload. Please try again.", code: "UPLOAD_URL_FAILED", detail: error.message, requestId }),
    };
  }
};
