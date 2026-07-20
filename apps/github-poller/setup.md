# Running the GitHub poller on Railway

The **no-admin** path into the system. Where the webhook ingest needs repo-admin rights to configure,
this needs only tokens you can issue for your own account — which is the whole reason it exists.

Run it *as well as* the webhook where you can: the webhook is real-time and full-fidelity, the poller
catches what the webhook does not cover and backstops a delivery GitHub failed to make (it does not
retry them).

## 1. The two tokens, and why they are different

| Source | Token type | Scope | Where |
| :--- | :--- | :--- | :--- |
| Notifications inbox | **classic** PAT — nothing else works | `notifications` (or `repo`) | Settings → Developer settings → Personal access tokens → **Tokens (classic)** |
| Events API | any token, including fine-grained | read access to the repositories you care about | either token page |

> **`GET /notifications` does not accept a fine-grained PAT or a GitHub App token.** This is not a
> scope you can add — the endpoint is simply not available to those credential types. If you issue a
> fine-grained token and the notifications source keeps returning 401, that is why.

One token is enough to be useful. A missing token disables **that source** and logs why; the other
keeps running. With neither, the service starts, says so at `error`, and does nothing.

## 2. AWS credentials

The poller writes to S3 from outside AWS, so it needs an access key rather than a role. Terraform
creates the **user and its policy** but deliberately **not** the key — `aws_iam_access_key` would
write the secret into Terraform state, which lives in an S3 bucket more things can read than should
ever see a credential.

```bash
aws iam create-access-key \
  --user-name "$(terraform -chdir=infra/personal-events output -raw github_poller_user_name)"
```

The policy grants exactly three things: `PutObject` into the event bucket, `GetObject`/`PutObject` on
the single state key, and `ListBucket` for the start-up pre-flight. It cannot read the event history
it writes, and cannot delete anything.

## 3. Railway service variables

```bash
EVENT_BUCKET_NAME=$(terraform -chdir=infra/personal-events output -raw event_bucket_name)
STATE_BUCKET_NAME=$(terraform -chdir=infra/personal-events output -raw state_bucket_name)
STATE_KEY=$(terraform -chdir=infra/personal-events output -raw poller_state_key)
AWS_REGION=$(terraform -chdir=infra/personal-events output -raw event_bucket_region)
AWS_ACCESS_KEY_ID=…            # from step 2
AWS_SECRET_ACCESS_KEY=…        # from step 2
GITHUB_USERNAME=…              # your login; the Events API URL is built from it
GITHUB_NOTIFICATIONS_PAT=…     # classic PAT — omit to disable that source
GITHUB_EVENTS_PAT=…            # any token — omit to disable that source
ENV=prod
LOG_LEVEL=info
```

Optional, with sensible defaults: `NOTIFICATIONS_INTERVAL_MS` (60 000), `EVENTS_INTERVAL_MS`
(300 000), `MAX_BACKOFF_MS` (900 000), `SEEN_CAP` (1 000), `GITHUB_API_BASE_URL`.

`STATE_BUCKET_NAME` **must not** be the event bucket. A state object there sorts above every event
key and would strand the desktop notifier past every event that will ever exist — see
`infra/README.md` § "Two buckets, and why they must stay two".

## 4. Deploy

`railway.json` selects the Dockerfile, which builds from the **repository root** (a pnpm workspace
member cannot build in isolation — it depends on four sibling packages).

```bash
railway up
railway logs
```

Expect, in order: `event bucket reachable`, a `warn` for any source with no token, then
`github poller started` naming the sources it began.

## 5. Confirm it is working

A healthy poller is mostly quiet. At `info` you will see a `polled` line per cycle that found
something; at `debug`, a `nothing new` line for every 304.

```
{"level":"info","message":"polled","source":"notifications","fetched":3,"fresh":1,"written":1,…}
{"level":"debug","message":"nothing new","source":"events",…}
```

`nothing new` is the **good** steady state. A 304 costs nothing against the rate limit, which is what
lets the service poll continuously without exhausting the 5 000/hour budget.

To prove the whole path, make something happen on GitHub that reaches your inbox — ask someone to
request your review, or mention yourself in an issue — and watch for a `written` count, then find the
object:

```bash
aws s3 ls "s3://$EVENT_BUCKET_NAME/" --recursive | tail -5
```

## What to expect when things go wrong

| Log line | Meaning | What to do |
| :--- | :--- | :--- |
| `notifications source disabled: no GITHUB_NOTIFICATIONS_PAT` | that variable is unset | set it, or accept running events-only |
| `poll failed` with `HTTP 401` | the token is invalid, expired, or the wrong *type* for that endpoint | for notifications, confirm it is a **classic** PAT |
| `rate limited by GitHub; backing off` | 429, or 403 with no budget left | nothing — it honours `Retry-After` and resumes |
| `could not write events; NOT advancing the cursor…` | S3 refused the write | check the access key and the IAM policy; **the items are retried**, nothing is lost |
| `skipping unprocessable item` | one item failed validation | the line names the item id and the field; likely a genuine finding for `packages/github` |
| `poller state object is unreadable; starting from empty state` | the state object is corrupt or from an incompatible version | harmless once — recent items may be re-delivered; investigate if it repeats |
| `could not confirm the event bucket…` | the pre-flight was inconclusive (DNS, 5xx) | usually a container starting before its network; it retries |

## Two behaviours to know about

- **Restarts and redeploys resume.** Cursors and the dedupe set live in S3, not in a Railway volume —
  volumes cause redeploy downtime and do not survive the service moving. A `SIGTERM` (which Railway
  sends on redeploy) lets the in-flight cycle finish its write and schedules no further tick.
- **The same activity can produce two events.** A pull request may reach both your inbox and your
  activity feed; the two sources dedupe independently and both write, with different `name`s. That is
  deliberate for v1 — they carry different fidelity — and cross-source correlation is the lever if
  the double signal turns out to be unwanted.
