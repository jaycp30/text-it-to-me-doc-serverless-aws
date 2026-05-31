# Troubleshooting, Known Limitations & Teardown

## Troubleshooting

### Chat Or Processing Returns AccessDeniedException

Bedrock model access for `jp.anthropic.claude-sonnet-4-6` is not granted. Enable it in the Bedrock console → Model access (`ap-northeast-1`), then retry.

### Reminders Never Arrive

For SMS, confirm the destination number is verified (the account is in the SNS SMS sandbox by default) and check the spend limit. For email, confirm `SesFromEmail` is a verified identity. Check Lambda logs:

```bash
aws logs tail /aws/lambda/rx-notify-user --region ap-northeast-1 --since 30m --format short
```

### Frontend Changed But Behavior Did Not

Confirm Amplify finished deploying the latest commit, then hard-refresh. Amplify only deploys `frontend/`.

### Backend Changed But Behavior Did Not

A Git push does not deploy the backend. Run `sam build && sam deploy`.

### sam deploy Tried To Reach cloudformation.y.amazonaws.com

During `sam deploy --guided`, a value prompt was answered with `y` instead of Enter, which set the region (or another value) to the literal string `y`. Re-run and press Enter to accept bracketed defaults, or use plain `sam deploy` to read values from `samconfig.toml`.

### Prescription Reads OK But "0 Dose Reminders" Are Scheduled

**Symptom.** `/process` succeeds and the schedule renders in the UI, but `rx-process-prescription` logs end with `Saved schedule … with 0 dose reminders`, and CloudWatch shows repeated errors like:

```text
ERROR  Failed to schedule dose for prednisolone on 2026-06-01:
       Value 'rx-<uuid>-2026-06-01-0800-prednisolone' at 'name'
       failed to satisfy constraint: Member must have length less than or equal to 64
```

**Cause.** EventBridge Scheduler's `Name` field has a **64-character hard limit**. The original code built the name from `rx-` + a 36-char schedule UUID + date + time + medication name (≈68 chars) and truncated to `512` — the wrong limit, so every dose failed validation and nothing was scheduled.

**Fix.** `createDoseSchedule` now builds a short, collision-proof name — `rx-<date>-<time>-<medSlug(18)>-<random8>` — capped at 64 characters (worst case ≈46). The stored `scheduleName` still flows into DynamoDB so opt-out/unsubscribe deletion keeps working.

> Diagnosing this: tail `/aws/lambda/rx-process-prescription` after an upload. A clean run logs `Saved schedule … with N dose reminders` (N > 0). Any `failed to satisfy constraint` error on `name` points back to the 64-char limit.

### NetworkError When Attempting To Fetch Resource (During Upload)

**Symptom.** The upload screen shows `NetworkError when attempting to fetch resource` and no schedule is created. Retrying sometimes succeeds.

**Cause.** `/process` runs Bedrock synchronously and can take ~20–27s. It sits behind an HTTP API, which has a **hard 30-second integration timeout that cannot be raised**. A cold start plus a complex prescription (large taper) can push a single request past 30s; API Gateway then drops the connection and the browser reports a `NetworkError` (not an HTTP status). A warm Lambda on retry usually lands under 30s, which is why a second attempt often works.

**Diagnosis.** In DevTools → Network, the `process` request dies around the 30s mark. Confirm in CloudWatch whether the Lambda finished after the client gave up. A successful run reports `Duration: ~20000 ms` — close to, but under, the ceiling.

**Mitigation / fix.** Short term: keep `max_tokens` and the system prompt tight to speed Bedrock up. Proper fix: make `/process` asynchronous — return `202` immediately and have the frontend poll `GET /schedules` until the schedule is ready. This removes the 30s ceiling entirely.

---

## Known Limitations

The hosted app collects reminder details and sends the full `/process` body:

```json
{
  "imageKey": "...",
  "imageKeys": [
    "local-.../prescriptions/rx-upload-.../page-1.jpg",
    "local-.../prescriptions/rx-upload-.../page-2.jpg"
  ],
  "uploadId": "rx-upload-...",
  "userId": "local-...",
  "userTimezone": "Europe/London",
  "notificationMethod": "email",
  "contactInfo": "user@example.com"
}
```

Current limitations:

- **Local browser profile only.** `userId` is generated in the browser and stored in localStorage. This is fine for the learning build, but it is not a production identity system.
- **Five-image upload cap.** The UI and backend intentionally limit one processing run to 5 prescription pages/screenshots to control cost and processing time.
- **SMS sandbox.** SNS SMS still delivers only to verified sandbox destination numbers until AWS approves a production access request.
- **Email reminders require real recipient details.** SES is production-enabled, but the user must enter a valid email address in the reminder details form.
- **Stop reminders cancels future doses only.** Doses that have already fired are gone. If a prescription is re-uploaded after stopping, new Scheduler rules are created from that point forward.

Use **demo mode** for a no-side-effects walkthrough, and use a real upload only when you are ready to test S3 upload, Bedrock extraction, DynamoDB writes, and reminder scheduling.

---

## Teardown

```bash
# Empty the S3 bucket first — CloudFormation will not delete a non-empty bucket
BUCKET=$(aws cloudformation describe-stacks --stack-name text-it-to-me-doc \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ImagesBucketName'].OutputValue" --output text)
aws s3 rm "s3://$BUCKET" --recursive

sam delete --stack-name text-it-to-me-doc --region ap-northeast-1
# Delete the Amplify app separately from the Amplify console.
```
