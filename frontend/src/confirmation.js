/**
 * confirmation.js
 *
 * Pure helpers for the subscription-confirmation banner (issue #10):
 * deriving what status to show, and enforcing a client-side resend cooldown
 * ("within rate limits"). No React, no DOM — unit-tested in confirmation.test.js.
 */

// Minimum gap between confirmation resends from the client.
export const RESEND_COOLDOWN_MS = 30000;

/**
 * @typedef {Object} ConfirmationStatus
 * @property {'sent'|'failed'|'unknown'} state
 * @property {string} channel
 */

/**
 * Decide what the confirmation banner should show.
 *
 * - SMS setups have no email confirmation → null (render nothing).
 * - Email setups with a backend `confirmation` → 'sent' (queued) or 'failed'.
 * - Email setups without a status (e.g. an idempotent replay that didn't
 *   re-send) → 'unknown', so we can still offer a resend without lying.
 *
 * @param {{ channel?: string, queued?: boolean }|null|undefined} confirmation
 * @param {string|undefined} method  'email' | 'sms'
 * @returns {ConfirmationStatus|null}
 */
export function deriveConfirmationStatus(confirmation, method) {
  if (method !== "email") return null;
  if (!confirmation) return { state: "unknown", channel: "email" };
  return { state: confirmation.queued ? "sent" : "failed", channel: confirmation.channel || "email" };
}

/**
 * Whether a resend is allowed given when the last one was sent.
 * @param {number|null|undefined} lastSentAt  epoch ms of the last resend, or null
 * @param {number} [now]
 * @param {number} [cooldownMs]
 * @returns {boolean}
 */
export function canResend(lastSentAt, now = Date.now(), cooldownMs = RESEND_COOLDOWN_MS) {
  if (!lastSentAt) return true;
  return now - lastSentAt >= cooldownMs;
}

/**
 * Milliseconds remaining before a resend is allowed again (0 when allowed).
 * @param {number|null|undefined} lastSentAt
 * @param {number} [now]
 * @param {number} [cooldownMs]
 * @returns {number}
 */
export function cooldownRemainingMs(lastSentAt, now = Date.now(), cooldownMs = RESEND_COOLDOWN_MS) {
  if (!lastSentAt) return 0;
  return Math.max(0, cooldownMs - (now - lastSentAt));
}
