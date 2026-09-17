# Understanding checklist

A running record of the non-obvious things behind recent changes, so the work can
be explained and defended without re-reading every diff. One section per piece of
substantial work, newest first. Tick items off as they are demonstrated, not as
they are read.

---

## Issue #25 — erasure actually deletes (2026-09-17)

### The problem, and why it existed

`DELETE /reminders/{userId}` was the app's only opt-out path, reachable from the
unsubscribe link in every reminder email. It deleted the EventBridge Scheduler
rules and set `active: false` on the DynamoDB rows — and nothing else. The
prescription photographs, the extracted medications, and the user's email address
or phone number all survived: in S3 indefinitely, and in both DynamoDB tables for
a year.

The user was told "unsubscribed" and reasonably concluded their prescription photo
was gone. It was not.

This is the textbook erasure failure, and the reason it is easy to ship is that
**the row the UI reads is the row that gets cleared**. Every screen in the app
looked correct. Only a direct look at S3 or the other table showed the truth.

It matters more than usual here because the legal basis for processing this data
is consent (GDPR Art. 9 — prescriptions are special-category health data). When
someone withdraws the only basis you had, continuing to hold the data for another
year is not defensible on any other ground.

- [ ] Can explain why cancelling and erasing are different user intents
- [ ] Can explain why consent as a legal basis makes retention-after-withdrawal
      indefensible, where "contract necessity" might not have

### The solution, and why it beat the alternatives

A **separate** `deleteUserData` Lambda on `DELETE /data/{userId}`, rather than
extending the existing cancel handler.

The deciding factor was IAM blast radius. Erasure needs `s3:DeleteObject` on the
prescription images bucket. `cancelReminders` is reachable one click from every
email the app sends; giving that function the power to delete images would mean a
bug or a token leak in the least-guarded path could destroy data. Two functions,
two roles, two different levels of danger.

Cancel stays reversible, because the restore flow depends on those records
surviving.

- [ ] Can explain why a separate function beat adding a flag to the existing one

### Design decisions

**Delete order: Scheduler rules → S3 → DynamoDB last.**

The DynamoDB rows are the *index* of what exists — they hold the rule names and
the image keys. Deleting them first means a later failure leaves prescription
images in S3 that no query can ever find again: orphaned, permanent, invisible.
Deleting the index last makes the whole operation **retryable** — a second call
re-enumerates whatever is left and finishes the job. Scheduler rules go first so
no reminder can fire mid-erasure and write fresh contact details into the logs.

- [x] Can explain why the index is deleted last (demonstrated 2026-09-17)

**S3 is enumerated by prefix, not from the stored `imageKeys`.**

`/upload-url` writes an object to S3 before `/process` is ever called. A user who
uploads and then abandons the flow leaves an image with **no DynamoDB row
pointing at it**. Deleting by the stored index would have missed those forever.
Listing `<userId>/prescriptions/` catches them. The trailing slash is
load-bearing: prefix `abc` would also match `abcd/`, deleting another user's
images.

- [ ] Can explain why trusting the index would have silently orphaned uploads

**The email link does not act; it opens a confirmation.**

`?unsubscribe=` auto-fires on page load, which is fine because cancelling is
reversible. `?delete=` deliberately does not. Mail clients and corporate security
appliances routinely prefetch every link in an email — a one-click irreversible
delete would let a scanner destroy someone's prescription data before they read a
word of the page.

- [ ] Can explain why auto-firing is acceptable for one link and not the other

**No tombstone record.** A permanent "user X was erased" row would mean retaining
an identifier in order to prove we stopped retaining identifiers. The audit trail
is one log line with the user id and per-store counts, in a group that expires at
30 days.

- [ ] Can explain the tradeoff against Art. 5(2) accountability evidence

**Partial failure returns 500 with the counts, and the UI does not clear
localStorage.** `Promise.allSettled` never throws, so without inspecting the
rejections a half-failed erasure would return a cheerful 200 — recreating the
exact bug this issue exists to fix. Keeping localStorage on failure matters too:
clearing it would destroy the session token the user needs to retry.

- [ ] Can explain why `Promise.allSettled` is a silent-failure risk

### Gotchas hit while building

**SAM packages each function's `CodeUri` alone.** The first version imported
`verifySessionToken` from `../cancelReminders/lib` to avoid duplicating an HMAC
verifier. That resolves locally, `sam build` succeeds, the stack deploys green —
and the first real invocation throws `Cannot find module`, because the sibling
directory is not in the zip. The verifier is now copied, with an equivalence test
(`backend/tests/deleteUserData.test.js`) that runs both implementations over the
same cases and fails if they ever diverge. Verified by deliberately breaking the
copy and watching the guard fire.

**A CSS animation's value beats an inline style.** The dialog was centred with
`transform: translate(-50%, -50%)` and sat visibly off-centre. `.anim-fade-up`
animates `transform` with `fill-mode: both`, so its final keyframe
(`translateY(0)`) permanently overrode the inline transform. Fixed by centring
with flexbox instead, so nothing competes for `transform`.

- [ ] Can explain why the cross-directory require deploys green and fails at runtime
- [ ] Can explain why the animation won over the inline style

### Broader impact

- Every reminder email now carries a "Delete my data" link beside Unsubscribe.
- The privacy policy states plainly that stopping reminders and deleting data are
  different things, and gives the email fallback for anyone who cleared their
  browser storage and can no longer reach their own records.
- `POLICY_VERSION` bumped to `2026-09-17` to match, so consent evidence records
  which policy text was agreed to.
