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
 *   Frontend → POST /upload-url → gets { uploadUrl, imageKey, uploadId }
 *   Frontend → PUT uploadUrl (with image bytes) → image in S3
 *   Frontend → POST /process { imageKeys, uploadId, ... } → prescription processed
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");

const s3 = new S3Client({});
const IMAGES_BUCKET = process.env.IMAGES_BUCKET;

// Allowed image types
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
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

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const body = JSON.parse(event.body || "{}");
    const { userId, contentType, uploadId, pageNumber } = body;

    if (!userId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "userId required" }) };
    }

    const fileType = contentType || "image/jpeg";

    if (!ALLOWED_CONTENT_TYPES.includes(fileType)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Content type ${fileType} not allowed. Use JPEG, PNG, or HEIC.` }),
      };
    }

    const page = Number(pageNumber || 1);
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `pageNumber must be between 1 and ${MAX_PAGE_NUMBER}` }),
      };
    }

    // Key format: userId/prescriptions/uploadId/page-N.ext
    // S3 "folders" are prefixes; grouping pages under uploadId keeps one
    // prescription's screenshots together for traceability.
    const ext = fileType.split("/")[1].replace("jpeg", "jpg");
    const safeUserId = safeSegment(userId);
    const safeUploadId = safeSegment(uploadId) || `rx-upload-${randomUUID()}`;
    const imageKey = `${safeUserId}/prescriptions/${safeUploadId}/page-${page}.${ext}`;

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
      body: JSON.stringify({ uploadUrl, imageKey, uploadId: safeUploadId, pageNumber: page }),
    };

  } catch (error) {
    console.error("getUploadUrl error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
