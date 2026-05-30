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
 *   Frontend → POST /upload-url → gets { uploadUrl, imageKey }
 *   Frontend → PUT uploadUrl (with image bytes) → image in S3
 *   Frontend → POST /process { imageKey, ... } → prescription processed
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

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const body = JSON.parse(event.body || "{}");
    const { userId, contentType } = body;

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

    // Key format: userId/prescriptions/UUID.jpg
    // Scoped to userId so we can use S3 prefix policies if needed
    const ext = fileType.split("/")[1].replace("jpeg", "jpg");
    const imageKey = `${userId}/prescriptions/${randomUUID()}.${ext}`;

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
      body: JSON.stringify({ uploadUrl, imageKey }),
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
