/**
 * job.js
 *
 * Pure helpers for the asynchronous processing job introduced in issue #5.
 *
 * POST /process no longer returns a prescription. It returns 202 with a
 * scheduleId, and the client polls GET /schedules until the record for that id
 * reports complete or failed. These helpers hold the decision logic so it can
 * be unit-tested without fetch, timers, or React.
 *
 * Pure module — no React, no DOM, no network. Tested in frontend/src/job.test.js.
 */

/** How often to poll while a job is running. */
export const JOB_POLL_INTERVAL_MS = 2000;

/**
 * How long to keep polling before giving up.
 *
 * The worker has a 300s Lambda timeout, but if it is killed outright its catch
 * block never runs and the record stays "processing" forever. The client needs
 * its own deadline so the user sees a TIMEOUT rather than an endless spinner.
 * 180s comfortably covers a slow Bedrock read (30-60s is typical).
 */
export const JOB_POLL_DEADLINE_MS = 180000;

/**
 * Did POST /process hand back a job to poll, or a finished result?
 *
 * During the window between the frontend deploying (automatic, via Amplify on
 * merge) and the backend deploying (manual `sam deploy`), the old synchronous
 * handler is still live and answers 200 with a full prescription. Detecting the
 * shape rather than assuming one makes the deploy order irrelevant in both
 * directions. Remove once the async backend is deployed everywhere.
 */
export function isAsyncJobResponse(payload) {
  return Boolean(payload && payload.status === 'processing' && payload.scheduleId);
}

/**
 * Pick this job's record out of a GET /schedules response.
 *
 * Polling must pass includeInactive=true: the record is written with
 * active:false when the lock is claimed and only flips to true on success, so
 * the default active-only filter hides the job while it is running.
 */
export function findJob(schedules, scheduleId) {
  if (!Array.isArray(schedules) || !scheduleId) return null;
  return schedules.find(s => s?.scheduleId === scheduleId) || null;
}

/**
 * Reduce a polled record to what the UI needs.
 *
 * `pending` covers both "no record yet" and "still processing" — the caller
 * treats them identically (keep polling), and a brief absence is normal since
 * DynamoDB reads are eventually consistent.
 */
export function interpretJobRecord(record) {
  if (!record) return { state: 'pending', stage: null, code: null, message: null };

  const status = record.processingStatus;

  if (status === 'complete') {
    return { state: 'complete', stage: 'finishing', code: null, message: null, record };
  }

  if (status === 'failed') {
    return {
      state: 'failed',
      stage: null,
      // The worker records the stable error code alongside the message so the
      // frontend can show copy specific to the failure (issue #5: "failed jobs
      // surface specific user-facing errors"). Older records predate the code.
      code: record.failureCode || 'PROCESSING_FAILED',
      message: record.failureMessage || null,
      record,
    };
  }

  return { state: 'pending', stage: record.processingStage || null, code: null, message: null, record };
}

/**
 * Has the client waited long enough to give up?
 */
export function isPollExpired(startedAt, now = Date.now(), deadlineMs = JOB_POLL_DEADLINE_MS) {
  return now - startedAt >= deadlineMs;
}
