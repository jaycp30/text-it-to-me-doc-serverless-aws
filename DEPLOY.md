# Deployment Runbook — Text it To Me Doc

Target: your AWS account `441342223857`, region **ap-northeast-1 (Tokyo)**.
Backend = SAM (Lambda/API GW/DynamoDB/S3/EventBridge/SNS/SES).
Frontend = Amplify Hosting.

Your tooling is already good: `aws 2.34`, `sam 1.159`, `node 22`, credentials configured.

---

## STATUS: backend is DEPLOYED and verified ✅ (2026-05-30)

Steps 1–5 are DONE. The SAM backend is live in **ap-northeast-1**, stack
**`text-it-to-me-doc`**. The `/chat` smoke test passed against Bedrock
`jp.anthropic.claude-sonnet-4-6`.

**Live values:**
- **ApiUrl** (use as `VITE_API_BASE_URL` in Amplify): `https://dr4auuv5p7.execute-api.ap-northeast-1.amazonaws.com/v1`
- ImagesBucket: `rx-reader-images-441342223857`
- SNS topic: `arn:aws:sns:ap-northeast-1:441342223857:rx-notifications`
- Scheduler group: `rx-medication-reminders`
- Model: `jp.anthropic.claude-sonnet-4-6` (Japan-resident, vision) · Sender: `noreply@jaycloud.net`

**Remaining:** Step 6 (Amplify frontend) → Step 7 (Cognito auth + onboarding).
SNS SMS is still in **sandbox** with **no verified destination number** — add one in
the console before testing real SMS (non-blocking for the app).

---

## STATUS: local code changes are DONE ✅

All the file-level work (Steps 1, 2, 2.5) has already been applied and verified with
`sam validate --lint` (passes clean) and `sam build` (all 6 functions build, luxon bundled).

**What's already done for you:**
- ✅ Lambdas restructured into `backend/functions/<name>/index.js` + `package.json`
- ✅ Chat Lambda created (`backend/functions/chat/`) + route added to `template.yaml`
- ✅ Frontend chat call now sends `prescription`
- ✅ Template fixed: circular dependency removed, runtime bumped to `nodejs24.x`

**What's left for YOU (the AWS actions that cost money / need your accounts):**
- Step 3 — enable Bedrock access, get your `apac.` model ID
- Step 4 — verify SES sender + SNS test number
- Step 5 — `sam deploy --guided`
- Step 6 — git push + Amplify
- Step 7 — (later) Cognito auth + onboarding wiring

Steps 1, 2, 2.5 below are kept for reference, but you can skip straight to **Step 3**.

---

## 0. Gaps this runbook closes

Before deploy, the repo has these issues. The steps below fix each one:

1. **No `backend/` folder.** The 5 Lambda files sit flat at the repo root, but `template.yaml` expects `backend/functions/<name>/index.js` + a `package.json` each. → Step 1.
2. **No `chat` Lambda.** The frontend calls `POST /chat` in production but no function/route exists. → Step 2.
3. **Bedrock model ID is wrong for Tokyo.** Template default uses the `us.` prefix; Tokyo needs `apac.`. → Step 3.
4. **Frontend/backend contract is incomplete** (no Cognito auth yet, so `userId` / `contactInfo` / timezone aren't sent from the app). The backend deploys and works when called directly, but the *app→backend* happy path needs auth wiring you do later. → Step 7 "Known limitations."

> If you only want something live *today*: do **Step 6 (Amplify) alone** — the React app runs fully in demo mode with no backend. The SAM backend (Steps 1–5) can follow.

---

## Step 1 — Restructure the backend into `backend/functions/`

Run from the repo root (`/Users/jaycpantinople/Claude-test/text-it-to-me-doc-app`):

```bash
# Create the folders the template expects
mkdir -p backend/functions/{getUploadUrl,processPrescription,notifyUser,dailySummary,getSchedules,chat}

# Move each root .js file into its folder, renamed to index.js (the handler)
git mv getUploadUrl.js        backend/functions/getUploadUrl/index.js        2>/dev/null || mv getUploadUrl.js        backend/functions/getUploadUrl/index.js
mv processPrescription.js     backend/functions/processPrescription/index.js
mv notifyUser.js              backend/functions/notifyUser/index.js
mv dailySummary.js            backend/functions/dailySummary/index.js
mv getSchedules.js            backend/functions/getSchedules/index.js
```

Now create a `package.json` in **each** folder. The `nodejs20.x` runtime ships the AWS SDK v3, but `luxon` is NOT bundled and SDK versions drift — so we pin every dependency each function imports.

**`backend/functions/getUploadUrl/package.json`**
```json
{
  "name": "rx-get-upload-url",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0"
  }
}
```

**`backend/functions/processPrescription/package.json`**
```json
{
  "name": "rx-process-prescription",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.700.0",
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/lib-dynamodb": "^3.700.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/client-scheduler": "^3.700.0",
    "luxon": "^3.5.0"
  }
}
```

**`backend/functions/notifyUser/package.json`**
```json
{
  "name": "rx-notify-user",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-sns": "^3.700.0",
    "@aws-sdk/client-ses": "^3.700.0"
  }
}
```

**`backend/functions/dailySummary/package.json`**
```json
{
  "name": "rx-daily-summary",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/lib-dynamodb": "^3.700.0",
    "@aws-sdk/client-lambda": "^3.700.0",
    "luxon": "^3.5.0"
  }
}
```

**`backend/functions/getSchedules/package.json`**
```json
{
  "name": "rx-get-schedules",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/lib-dynamodb": "^3.700.0"
  }
}
```

**`backend/functions/chat/package.json`**
```json
{
  "name": "rx-chat",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.700.0"
  }
}
```

---

## Step 2 — Create the chat Lambda

The frontend's production chat path (`ChatDrawer.send()` in `frontend/src/App.jsx`) does:
```js
fetch(`${API_BASE}/chat`, { method:'POST', body: JSON.stringify({ message, history }) })
```
It does **not** currently send the prescription, but the Lambda needs it for context. Two small things:

**2a.** Create **`backend/functions/chat/index.js`**:

```js
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
```

**2b.** Add the function + route to `template.yaml`. Paste this block right **before** the `# ─── Outputs ───` line:

```yaml
  # ── Lambda: AI chat about the prescription ────────────────────────────────
  ChatFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: rx-chat
      Handler: index.handler
      CodeUri: backend/functions/chat/
      Timeout: 60
      Policies:
        - Statement:
            - Effect: Allow
              Action:
                - bedrock:InvokeModel
                - bedrock:InvokeModelWithResponseStream
              Resource: "*"
      Events:
        Chat:
          Type: HttpApi
          Properties:
            ApiId: !Ref RxApi
            Path: /chat
            Method: POST
```

**2c.** (Optional, makes app chat work end-to-end) In `frontend/src/App.jsx`, the production chat fetch body should include the prescription. Find:
```js
body: JSON.stringify({ message: trimmed, history }),
```
and change to:
```js
body: JSON.stringify({ message: trimmed, history, prescription: rx || MOCK_RX }),
```

---

## Step 2.5 — Fix two template bugs the linter caught (REQUIRED)

`sam validate --lint` flags two issues in `template.yaml`. The first is a hard deploy blocker.

### 2.5a — Circular dependency (hard blocker)

The `Globals` block applies these env vars to **every** function, including `NotifyUserFunction` itself — so NotifyUser ends up referencing its own ARN → CloudFormation circular dependency, deploy fails.

In `template.yaml`, **remove** these two lines from `Globals → Function → Environment → Variables`:
```yaml
        NOTIFIER_FUNCTION_ARN: !GetAtt NotifyUserFunction.Arn   # DELETE from Globals
        SCHEDULER_ROLE_ARN:   !GetAtt SchedulerRole.Arn          # DELETE from Globals
```

Then add them back **only on the two functions that actually need them.**

In `ProcessPrescriptionFunction`, add an `Environment` block (it currently has none):
```yaml
  ProcessPrescriptionFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: rx-process-prescription
      Handler: index.handler
      CodeUri: backend/functions/processPrescription/
      Timeout: 120
      Environment:
        Variables:
          NOTIFIER_FUNCTION_ARN: !GetAtt NotifyUserFunction.Arn
          SCHEDULER_ROLE_ARN:   !GetAtt SchedulerRole.Arn
      Policies:
        # ...leave the existing Policies block unchanged...
```

In `DailySummaryFunction`, it already has an `Environment` block with `SES_FROM_EMAIL` — add the notifier ARN to it:
```yaml
      Environment:
        Variables:
          SES_FROM_EMAIL: !Ref SesFromEmail
          NOTIFIER_FUNCTION_ARN: !GetAtt NotifyUserFunction.Arn   # ADD this line
```

`DailySummaryFunction` also *invokes* NotifyUser but has no IAM permission to. Add a Lambda-invoke policy to its `Policies` list:
```yaml
        - LambdaInvokePolicy:
            FunctionName: !Ref NotifyUserFunction
```

### 2.5b — Bump the Node runtime (EOL)

`nodejs20.x` is end-of-life (new-function creation disabled from 2026-06-01). In `Globals → Function`, change:
```yaml
  Function:
    Runtime: nodejs24.x        # was nodejs20.x
```
Then update the six `package.json` files in Step 1 to match the runtime — they're fine as written (SDK v3 works on nodejs24.x), no change needed there.

> After these edits, re-run `sam validate --lint --region ap-northeast-1` — it should pass clean (or show only informational notes).

---

## Step 3 — Fix the Bedrock model ID for Tokyo (important)

The template default `us.anthropic.claude-3-5-sonnet-20241022-v2:0` is a **US** inference profile and will fail in Tokyo. First enable model access, then get the correct `apac.` ID:

```bash
# 3a. Enable access in the console (one time):
#   AWS Console → Bedrock → Model access → enable the Anthropic Claude models you want.

# 3b. List the inference profiles actually available to you in Tokyo:
aws bedrock list-inference-profiles \
  --region ap-northeast-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId" \
  --output table
```

Pick an `apac.anthropic.claude-…` ID from that list (e.g. an `apac.anthropic.claude-3-5-sonnet-*` or newer Claude). You'll pass it at deploy time in Step 5 via `BedrockModelId=...`. Don't hand-guess the ID — use whatever the command returns for your account.

---

## Step 4 — Set notification prerequisites (you chose BOTH SMS + Email)

The `notifyUser` Lambda already supports both channels via `notificationMethod: "sms" | "email"`. You just need to satisfy AWS's send requirements.

**Email (SES):**
```bash
# Verify your sender address (you'll click a link in the email AWS sends)
aws ses verify-email-identity --email-address you@yourdomain.com --region ap-northeast-1

# While in the SES sandbox you can ONLY send to verified addresses — verify any test recipients too:
aws ses verify-email-identity --email-address test-recipient@gmail.com --region ap-northeast-1
```
You'll pass `SesFromEmail=you@yourdomain.com` at deploy (Step 5). To email arbitrary users later, request SES production access in the console (SES → Account dashboard → Request production access).

**SMS (SNS):**
- New accounts are in the **SNS SMS sandbox** — you can only text **verified** numbers until you request production access.
- Console: SNS → Text messaging (SMS) → Sandbox destination phone numbers → add + verify your number (you'll enter an OTP).
- Set a monthly spend limit there too (e.g. $1) so a bug can't run up a bill.
- Philippines (+63) delivery is carrier-dependent — test with your own number first. Numbers must be E.164 (`+639XXXXXXXXX`).

---

## Step 5 — Build & deploy the backend (SAM)

```bash
cd /Users/jaycpantinople/Claude-test/text-it-to-me-doc-app

# Validate the template first
sam validate --lint --region ap-northeast-1

# Build (installs each function's package.json deps)
sam build

# First deploy — guided. Accept defaults; when prompted, set parameters:
sam deploy --guided \
  --region ap-northeast-1 \
  --stack-name text-it-to-me-doc \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "BedrockModelId=apac.anthropic.claude-3-5-sonnet-20241022-v2:0" \
    "SesFromEmail=you@yourdomain.com"
```
Replace the `BedrockModelId` with the exact ID from Step 3b and `SesFromEmail` with your verified sender.

> Note: `samconfig.toml` currently has `stack_name = "rx-reader"`. Using `--stack-name text-it-to-me-doc` above overrides it; or edit `samconfig.toml` to match. Either is fine — just be consistent on later deploys.

When it finishes, copy the **`ApiUrl`** output (looks like `https://abc123.execute-api.ap-northeast-1.amazonaws.com/v1`). You need it for Amplify.

Subsequent deploys are just:
```bash
sam build && sam deploy
```

**Quick backend smoke test** (no app needed):
```bash
API="https://YOUR-API-ID.execute-api.ap-northeast-1.amazonaws.com/v1"
curl -s -X POST "$API/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is amoxicillin for?","prescription":{"medications":[{"name":"amoxicillin","dose_mg":500}]}}'
```
A JSON `{ "reply": "..." }` means Bedrock + API Gateway + the chat Lambda all work.

---

## Step 6 — Deploy the frontend (Amplify)

The app needs to be in a Git repo connected to Amplify. It currently is **not** a git repo.

```bash
cd /Users/jaycpantinople/Claude-test/text-it-to-me-doc-app
git init
printf "node_modules/\ndist/\n.DS_Store\n.aws-sam/\n.env\n" > .gitignore
git add -A
git commit -m "Initial commit — Text it To Me Doc"
# Create a repo on GitHub, then:
git remote add origin https://github.com/<you>/text-it-to-me-doc.git
git branch -M main
git push -u origin main
```

In the Amplify console (ap-northeast-1):
1. **New app → Host web app → GitHub →** authorize → pick the repo + `main` branch.
2. Amplify auto-detects a build. Because the app lives in `frontend/`, set the **app root / monorepo path to `frontend`**, or use this build spec (`amplify.yml` at repo root):

```yaml
version: 1
applications:
  - appRoot: frontend
    frontend:
      phases:
        preBuild:
          commands:
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
```
(Vite outputs to `dist/`, not `build/` — make sure baseDirectory is `dist`.)

3. **Environment variables** (App settings → Environment variables):
   - `VITE_API_BASE_URL` = the `ApiUrl` from Step 5
   - (do **not** set `VITE_ANTHROPIC_KEY` in production — that path is only for local preview; prod goes through your Lambdas)

   ⚠️ The README mentions `VITE_API_URL` — that's a typo. The code reads **`VITE_API_BASE_URL`** (see `frontend/src/App.jsx`). Use that exact name.

4. Save & deploy. Amplify gives you a `https://main.<id>.amplifyapp.com` URL.

5. **Tighten CORS** after you have the Amplify URL: in `template.yaml`, replace the two `AllowedOrigins/AllowOrigins: ["*"]` (the S3 bucket CORS and the `RxApi` CORS) with your Amplify URL, then `sam build && sam deploy`.

---

## Step 7 — Known limitations (the app→backend happy path)

The backend deploys and each Lambda works when called directly, but the **app isn't fully wired to it yet** because there's no auth/onboarding:

- **No Cognito auth.** `userId` is mocked in the frontend. `getUploadUrl`, `processPrescription`, and `getSchedules` all require a real `userId`. You'll add Amplify Auth (Cognito) and a JWT authorizer on the API, then pass the Cognito `sub` as `userId`.
- **No onboarding for contact info.** `processPrescription` requires `contactInfo` (phone/email), `notificationMethod`, and `userTimezone` — there's no UI collecting these yet. Add an onboarding step that captures them and include them in the `/process` call.
- **Frontend `/process` body is minimal.** It currently sends only `{ imageKey }`; the Lambda needs `{ imageKey, userId, userTimezone, notificationMethod, contactInfo }`.

Until those are done, use **demo mode** (the "Try with sample prescription" button) for the live app, and the curl smoke tests above to validate the backend. None of this blocks deploying — it's the next milestone after infrastructure is up.

---

## Teardown (if you want to remove everything)

```bash
# Empty the S3 bucket first (CloudFormation won't delete a non-empty bucket)
BUCKET=$(aws cloudformation describe-stacks --stack-name text-it-to-me-doc \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ImagesBucketName'].OutputValue" --output text)
aws s3 rm "s3://$BUCKET" --recursive

sam delete --stack-name text-it-to-me-doc --region ap-northeast-1
# Delete the Amplify app from the Amplify console separately.
```

---

## Order of operations (TL;DR)

1. Restructure backend → `backend/functions/*` + package.json (Step 1)
2. Add chat Lambda + template route (Step 2)
3. Fix template: circular dep + Node runtime bump (Step 2.5) — REQUIRED
4. Enable Bedrock access; get the `apac.` model ID (Step 3)
5. Verify SES sender + SNS test number (Step 4)
6. `sam validate` → `sam build` → `sam deploy --guided`; copy `ApiUrl` (Step 5)
7. git init + push; Amplify connect; set `VITE_API_BASE_URL`; deploy (Step 6)
8. Plan the auth/onboarding wiring for the full app flow (Step 7)
