# Operating the GitHub poller

The **no-admin** path into the system: an EventBridge-scheduled Lambda that polls the Notifications
inbox and the Events API for repositories where you cannot set a webhook. Where the webhook handler
carries real-time load for repos you administer, this fills the gaps on a one-minute timer.

Run it *as well as* the webhook where you can — the poller also backstops a webhook delivery GitHub
failed to make (it does not retry them).

## 1. The two tokens, and why they differ

| Source | Token type | Scope | Where |
| :--- | :--- | :--- | :--- |
| Notifications inbox | **classic** PAT — nothing else works | `notifications` (or `repo`) | Settings → Developer settings → Personal access tokens → **Tokens (classic)** |
| Events API | any token, including fine-grained | read access to the repositories you care about | either token page |

> `GET /notifications` does **not** accept a fine-grained PAT or a GitHub App token — it is not a
> scope you can add, the endpoint is unavailable to those credential types. If the notifications
> source keeps logging `poll failed` with HTTP 401/403, that is why.

Each token lives in an **SSM SecureString** that Terraform creates as a placeholder. Set the ones you
have; a placeholder/absent token disables *its own* source and leaves the other running.

```bash
aws ssm put-parameter \
  --name "$(terraform -chdir=infra/personal-events output -raw github_notifications_pat_parameter)" \
  --type SecureString --value "<classic PAT>" --overwrite

aws ssm put-parameter \
  --name "$(terraform -chdir=infra/personal-events output -raw github_events_pat_parameter)" \
  --type SecureString --value "<any PAT>" --overwrite
```

The Lambda reads these fresh every invocation, so a rotated PAT is picked up on the next tick — no
redeploy.

## 2. The GitHub username

The Events API URL is `/users/{username}/received_events`. Set the login at apply time:

```bash
terraform -chdir=infra/personal-events apply -var github_username=<your-login>
```

(The Notifications inbox needs no username — it is the authenticated user's own inbox.)

## 3. Deploy

The Lambda's bundle is the tsup output; `archive_file` zips it, so it must be **built before plan or
apply** (turbo's `plan`/`deploy` tasks depend on `^build`, so `pnpm deploy` at the root does this):

```bash
pnpm --filter @personal-events/github-poller build
terraform -chdir=infra/personal-events apply -var github_username=<your-login>
```

Terraform creates the function, an EventBridge `rate(1 minute)` rule, the two SSM placeholders, a
least-privilege role, and reserves **one** concurrent execution (so two invocations can never
overlap — the property that makes the single combined state object safe).

## 4. Confirm it is working

```bash
FUNCTION=$(terraform -chdir=infra/personal-events output -raw github_poller_function_name)
aws logs tail "/aws/lambda/$FUNCTION" --since 5m --follow
```

Every invocation logs a `poll complete` line with what it wrote and what it skipped; a source that
found something logs `polled` with `written`. To force one now instead of waiting for the schedule:

```bash
aws lambda invoke --function-name "$FUNCTION" /dev/stdout
```

Then make something happen on GitHub that reaches your inbox (ask for a review, mention yourself) and
watch for a `written` count, then find the object:

```bash
EVENT_BUCKET=$(terraform -chdir=infra/personal-events output -raw event_bucket_name)
aws s3 ls "s3://$EVENT_BUCKET/" --recursive | tail -5
```

## What to expect in the logs

| Line | Meaning | What to do |
| :--- | :--- | :--- |
| `notifications source disabled: no GITHUB_NOTIFICATIONS_PAT_PARAM` | the env var is unset | it is set by Terraform; if you see this, the function env is wrong |
| `source disabled: its token could not be read from SSM` | the SSM parameter is a placeholder, empty, or denied | set the parameter (step 1); the other source keeps running |
| `poll failed` with HTTP 401 | the token is invalid, expired, or the wrong *type* | for notifications, confirm it is a **classic** PAT |
| `rate limited by GitHub; deferring the next poll` | 429, or 403 with no budget left | nothing — the source records a `notBefore` and skips ticks until GitHub's `Retry-After` elapses |
| `could not write events; NOT advancing the cursor…` | S3 refused the write | check the role and the bucket; **the items are retried** next invocation, nothing is lost |
| `skipping unprocessable item` | one item failed validation | the line names the id and the field; likely a genuine finding for `packages/github` |
| `poller state object is unreadable; starting from empty state` | the state object is corrupt | harmless once — recent items may be re-delivered, then the dedupe set suppresses them |
| `source not due yet; skipping this tick` | GitHub asked us to wait longer than 60s | expected; the source resumes when its `notBefore` passes |

## Two behaviours to know about

- **State survives everything.** Cursors, the dedupe set and the per-source `notBefore` live in one
  S3 object in the operational-state bucket (never the event bucket — see `infra/README.md`). A
  redeploy or a cold start resumes exactly where the last invocation left off.
- **The same activity can produce two events.** A pull request may reach both your inbox and your
  activity feed; the two channels dedupe independently and both write, with different `name`s. That
  is deliberate for v1 — they carry different fidelity — and cross-source correlation is the lever if
  the double signal turns out to be unwanted.
