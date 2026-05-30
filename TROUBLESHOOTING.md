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
