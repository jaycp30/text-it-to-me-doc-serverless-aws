/* ─────────────────────────────────────────────────────────────────────────────
   erasure.js

   Pure logic for the "delete my data" flow (GDPR Art. 17). Kept out of App.jsx
   so the confirmation rule, the email-link parsing and the result wording can be
   unit-tested without rendering anything — same split as job.js / schedule.js.

   The endpoint itself is DELETE /data/{userId}, which is a different route from
   DELETE /reminders/{userId}. Cancelling reminders is reversible; this is not.
───────────────────────────────────────────────────────────────────────────── */

/** localStorage keys that hold anything about the user, including contact info. */
export const LOCAL_STORAGE_KEYS = [
  'rxreader.userId',
  'rxreader.sessionToken',
  'rxreader.reminderDetails',
];

/** What the user has to type to arm the delete button. */
export const ERASURE_CONFIRM_PHRASE = 'DELETE';

/**
 * Whether the typed confirmation arms the irreversible action.
 *
 * Case-insensitive and trimmed on purpose: the point of type-to-confirm is to
 * force a deliberate act, not to test typing accuracy. Mobile keyboards
 * auto-capitalise and trailing spaces are easy to paste in, and failing someone
 * over either would just push them to email a support request instead.
 *
 * @param {string} typed
 * @returns {boolean}
 */
export function canConfirmErasure(typed) {
  if (typeof typed !== 'string') return false;
  return typed.trim().toUpperCase() === ERASURE_CONFIRM_PHRASE;
}

/**
 * Parse an erasure request out of a URL query string (`?delete=<id>&token=<t>`).
 *
 * Returning the details rather than acting on them is the whole point: the app
 * opens a confirmation dialog and waits for a click. Auto-firing on page load —
 * the way `?unsubscribe=` does — is safe for a reversible cancel, but here a
 * mail client or security scanner prefetching the link would irreversibly
 * destroy someone's data before they ever read the page.
 *
 * @param {string} search  e.g. window.location.search
 * @returns {{ userId: string, token: string|null }|null}
 */
export function parseErasureRequest(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return null;
  }

  const userId = params.get('delete');
  if (!userId) return null;

  return { userId, token: params.get('token') };
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Turn the per-store counts the API returns into one sentence a person can read.
 *
 * Deliberately itemised rather than a bare "done": the failure this whole issue
 * exists to fix was an app telling someone their data was gone while four stores
 * still held it. Showing what was actually removed is the evidence.
 *
 * @param {{ reminders?: number, images?: number, schedules?: number, prescriptions?: number }} counts
 * @returns {string}
 */
export function summarizeErasure(counts) {
  const { reminders = 0, images = 0, schedules = 0, prescriptions = 0 } = counts || {};

  const parts = [];
  if (images > 0)        parts.push(plural(images, 'prescription image'));
  if (prescriptions > 0) parts.push(plural(prescriptions, 'prescription record'));
  if (schedules > 0)     parts.push(plural(schedules, 'reminder schedule'));
  if (reminders > 0)     parts.push(plural(reminders, 'upcoming reminder'));

  if (parts.length === 0) {
    return 'There was nothing left to delete — your data is already gone.';
  }

  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  return `Deleted ${list}.`;
}
