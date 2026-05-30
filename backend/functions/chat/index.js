"use strict";

/**
 * chat/index.js
 * Bedrock-backed medication helper with strict guardrails.
 * Body: { message: string, history: [{role,text}], prescription: object }
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
const MODEL_ID = process.env.BEDROCK_MODEL_ID;

const systemPrompt = (rx) => `You are a friendly medication helper for "Text it To Me Doc".
Be warm, clear and concise — 8th-grade reading level.

Current prescription (JSON):
${JSON.stringify(rx || {}, null, 2)}

Rules:
- Only discuss medications in this prescription.
- Never recommend dose changes or stopping medication.
- Never diagnose.
- Emergency symptoms (chest pain, severe allergic reaction, fainting) → reply ONLY:
  "Please stop and call emergency services or go to the nearest ER immediately."
- Off-topic → "I can only help with questions about your current prescription."
- Max ~3 short paragraphs. You are not a doctor — remind users to verify with their
  pharmacist or prescriber.`;

module.exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const body = JSON.parse(event.body || "{}");
    const { message, history = [], prescription } = body;

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "message required" }) };
    }

    // Keep last 6 turns for a tight context window; map to Bedrock message shape.
    const messages = history
      .slice(-6)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] }));

    // Ensure the newest user message is present.
    if (!messages.length || messages[messages.length - 1].content[0].text !== message) {
      messages.push({ role: "user", content: [{ type: "text", text: message }] });
    }

    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      system: systemPrompt(prescription),
      messages,
    };

    const res = await bedrock.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    }));

    const parsed = JSON.parse(Buffer.from(res.body).toString("utf-8"));
    const reply = parsed.content?.[0]?.text || "Sorry, I couldn't generate a response.";

    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error("chat error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
