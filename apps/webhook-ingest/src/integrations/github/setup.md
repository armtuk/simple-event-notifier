# Setting up the GitHub webhook

What an operator has to do, once, to get real-time GitHub events landing in S3. The **poller**
(`apps/github-poller`, AWE-157) is the alternative for anyone who cannot complete step 1 — see
[Which path do I need?](#which-path-do-i-need).

## Which path do I need?

| | Webhook (this document) | Notifications poller |
| :--- | :--- | :--- |
| **Permission required** | repo **admin** (`admin:repo_hook`), or **org owner** for an org-wide hook | none beyond your own account |
| **Credential** | a webhook **secret** you choose; a *fine-grained* PAT with `write:repo_hook` only if registering via API | a **classic** PAT with `notifications` (or `repo`) scope |
| **Latency** | real time | one poll interval |
| **Fidelity** | the full event payload | the inbox item: reason, subject, repository |
| **Coverage** | every event type you subscribe to, for the repos you configure | only what reaches *your* notification inbox |

They are complementary, not exclusive: run both if you can. Each path dedupes independently, so a
PR that arrives by webhook **and** appears in your inbox produces two canonical events with
different `name`s — that is deliberate for v1 (see the feature plan).

**If you are only a contributor on the repositories you care about, you cannot do step 1 at all.**
That is the situation the poller exists for.

## 1. Generate and store the shared secret

The secret is what makes the endpoint safe: it is internet-facing and anyone can POST to it, so the
`X-Hub-Signature-256` HMAC is the entire gate.

```bash
SECRET=$(openssl rand -hex 32)

aws ssm put-parameter \
  --name "$(terraform -chdir=infra/personal-events output -raw github_webhook_secret_parameter)" \
  --type SecureString --value "$SECRET" --overwrite
```

Terraform creates the parameter with a **placeholder** value and `ignore_changes = [value]`, so the
real secret never enters Terraform state and a later `apply` will not revert it. Keep `$SECRET` to
hand for step 2, then discard it — nothing needs to store it a second time.

The function reads the parameter **once per cold start** and memoizes it. After rotating the secret,
GitHub deliveries will fail with 401 until the execution environment recycles; force it by
publishing a new function version or updating an environment variable.

## 2. Add the webhook in GitHub

Repository → **Settings → Webhooks → Add webhook** (or organization → Settings → Webhooks).

| Field | Value |
| :--- | :--- |
| **Payload URL** | `terraform -chdir=infra/personal-events output -raw github_webhook_url` |
| **Content type** | `application/json` — **not** `application/x-www-form-urlencoded` |
| **Secret** | the `$SECRET` from step 1 |
| **SSL verification** | enabled |
| **Events** | *Let me select individual events*: **Issues**, **Pull requests**, **Pull request reviews**, **Pushes**, **Releases** |

The content type matters: form-encoding wraps the payload in a `payload=` field, so the body the
HMAC covers is not the JSON the normalizer expects, and every delivery would 400.

Selecting *Send me everything* is not harmful — an event with no mapping rule is classified by the
config default and still written — but it is noisy. The five above are what
`packages/github/src/github-mapping.json` currently has rules for.

## 3. Confirm it works

GitHub sends a `ping` the moment you save. The ingest acknowledges it with **200** and writes
nothing.

```bash
FUNCTION=$(terraform -chdir=infra/personal-events output -raw ingest_function_name)
aws logs tail "/aws/lambda/$FUNCTION" --since 10m --follow
```

Then open a pull request and watch for a `github delivery written` line carrying the object key.
GitHub's **Recent Deliveries** tab shows the same exchange from its side, with a **Redeliver**
button — useful for testing, and safe: the delivery id is unchanged, so the second attempt is
deduped and answers `200 {"acknowledged":"duplicate delivery"}` without writing again.

## Responses, and what each one means

| Status | Meaning | What to do |
| :--- | :--- | :--- |
| `202` | events written | nothing |
| `200 acknowledged: ping` | the setup handshake | nothing |
| `200 acknowledged: duplicate delivery` | this delivery id was already written | nothing — this is dedupe working |
| `401` | signature missing or wrong | the secret in GitHub and the one in SSM disagree; redo step 1 |
| `400 invalid json` | the body was not JSON | check the content type is `application/json` |
| `400 unprocessable payload` | valid JSON, but a field the schema requires is missing or mistyped | the log line names the field; likely a genuine finding to fix in `packages/github` |
| `400 missing delivery id` | no `X-GitHub-Delivery` header | not something GitHub does; something else is posting to the endpoint |
| `500` | the S3 write, the secret read, or the dedupe check failed | check the log; **the delivery was not written** — use **Redeliver** once fixed |

## Two things to know about GitHub's delivery behaviour

- **GitHub does not automatically retry a failed delivery.** A 5xx is not a retry request; it makes
  the failure visible in the Recent Deliveries tab, where an operator can redeliver by hand for
  **three days**. The delivery-marker lifecycle keeps markers longer than that window
  (`delivery_marker_retention_days`, default 7) so a day-three redelivery is still deduped.
- **A delivery must be answered within roughly ten seconds.** The function's timeout is set to 10s
  and the work is one HMAC, one `HeadObject` and one `PutObject`, so this has headroom — but it is
  the reason the S3 write is synchronous and nothing else happens in the request path.

## Registering the hook via the API instead

If you would rather not click, a **fine-grained** PAT with repository permission
*Webhooks: Read and write* can create it. This is a different credential from the *classic* PAT the
poller needs; the poller's `GET /notifications` does not accept fine-grained tokens at all.

```bash
gh api -X POST "/repos/{owner}/{repo}/hooks" \
  -f 'name=web' -F 'active=true' \
  -f 'config[url]='"$(terraform -chdir=infra/personal-events output -raw github_webhook_url)" \
  -f 'config[content_type]=json' -f 'config[secret]='"$SECRET" \
  -f 'events[]=issues' -f 'events[]=pull_request' -f 'events[]=pull_request_review' \
  -f 'events[]=push' -f 'events[]=release'
```
