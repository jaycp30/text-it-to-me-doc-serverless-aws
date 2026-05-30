# RxReader — Prescription to Schedule, Serverless

Reads handwritten doctor prescriptions via Bedrock Claude.
Creates a medication timetable. Sends dose reminders via SMS or email.

---

## Architecture

```
Amplify (React frontend + Cognito auth)
    │
    ▼
API Gateway HTTP API
    │
    ├── POST /upload-url     → GetUploadUrl Lambda → S3 presigned URL
    ├── POST /process        → ProcessPrescription Lambda
    │                              → S3 (fetch image)
    │                              → Bedrock Claude (read prescription)
    │                              → DynamoDB (save prescription + schedule)
    │                              → EventBridge Scheduler (per-dose rules) ← Option A
    └── GET  /schedules      → GetSchedules Lambda → DynamoDB

EventBridge Scheduler (per dose) → NotifyUser Lambda → SNS SMS or SES email
EventBridge cron (hourly)        → DailySummary Lambda → NotifyUser ← Option B
```

---

## Prerequisites

```bash
node --version    # 20+
aws --version     # 2.x
sam --version     # 1.x
```

You also need:
- Bedrock model access enabled in ap-northeast-1
  Go to: AWS Console → Bedrock → Model access → Request access for Claude
- SES verified email (or domain) for email notifications
  Go to: AWS Console → SES → Verified identities → Add one

---

## Deploy Backend (SAM)

```bash
# First time
sam build
sam deploy --guided
# Accept all defaults, enter your SES from-email when prompted

# After that
sam build && sam deploy
```

After deploy, copy the ApiUrl from outputs. You'll need it for Amplify.

---

## Deploy Frontend (Amplify)

1. Push your frontend code to GitHub
2. Go to AWS Amplify console → New app → Host web app → Connect GitHub
3. Add environment variable: VITE_API_URL = (ApiUrl from SAM output)
4. Let Amplify build and deploy

---

## One-time: Enable Bedrock Model Access

This is easy to miss and will cause silent failures.

1. AWS Console → Amazon Bedrock → Model access (left sidebar)
2. Find Anthropic Claude models
3. Click "Request model access"
4. Wait a few minutes

---

## One-time: SES Sandbox

By default SES is in sandbox mode — it can only send to verified emails.
For real SMS users, request production access:
AWS Console → SES → Account dashboard → Request production access

For SMS: SNS in ap-northeast-1 should work for Philippines (+63) out of the box.
Test with your own number first.

---

## Tear Down

```bash
# Empty the S3 bucket first (CloudFormation can't delete non-empty buckets)
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name rx-reader \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ImagesBucketName'].OutputValue" \
  --output text)

aws s3 rm s3://$BUCKET --recursive

# Delete stack
sam delete --stack-name rx-reader --region ap-northeast-1
```

---

## File Structure

```
rx-reader/
├── template.yaml                          # SAM template (all AWS resources)
├── samconfig.toml                         # Deploy config (region, stack name)
├── README.md
└── backend/
    └── functions/
        ├── getUploadUrl/                  # Returns presigned S3 URL
        │   ├── index.js
        │   └── package.json
        ├── processPrescription/           # Core: Bedrock → schedule
        │   ├── index.js
        │   └── package.json
        ├── notifyUser/                    # SMS or email sender
        │   ├── index.js
        │   └── package.json
        ├── dailySummary/                  # Option B: morning summary
        │   ├── index.js
        │   └── package.json
        └── getSchedules/                  # Returns user's schedules
            ├── index.js
            └── package.json
```

---

## Cost Estimate

| Service | Free tier | Expected monthly |
|---|---|---|
| Lambda | 1M requests, 400K GB-sec | $0 |
| API Gateway | 1M requests | $0 |
| DynamoDB | 25 GB, 25 WCU/RCU | $0 |
| S3 | 5GB, 20K GET | $0 |
| EventBridge Scheduler | 14M invocations | $0 |
| SNS SMS | — | ~$0.03–0.05 per SMS |
| Bedrock Claude | — | ~$0.01–0.05 per prescription |

Realistic monthly cost for personal + friends: **under $5**.
