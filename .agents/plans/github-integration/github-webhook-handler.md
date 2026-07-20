---
id: AWE-156
title: GitHub webhook handler (signature verify → S3)
type: story
status: Implementation Adjustment
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Story: GitHub webhook handler (signature verify → S3)

## Definition

### User story
As a GitHub user who can configure webhooks
I want my repo/org webhook deliveries verified, classified, and stored as canonical events
So that I get real-time, high-fidelity GitHub events on S3 when I have permission to set up a
webhook.

### Acceptance criteria
- A GitHub `SourceAdapter` (registered on the AWE-155 ingest at `/github`) that:
  - **Verifies `X-Hub-Signature-256`** (HMAC-SHA256 of the raw body with the shared secret,
    timing-safe compare) — reusing **`@octokit/webhooks` v14.2.0** `verifyAndReceive` (pure
    ESM, typed payloads) rather than hand-rolling; a missing/invalid signature → **401**,
    logged, nothing written. Verify against the **raw** body before any JSON parse.
  - Reads `X-GitHub-Event` (+ action) and `X-GitHub-Delivery`, validates the payload via the
    AWE-154 GitHub schemas, normalizes, and runs `integration-core.transform` with the GitHub
    mapping config to produce canonical event(s) written to S3.
  - **Dedupes on `X-GitHub-Delivery`** so GitHub's automatic redelivery/retries don't create
    duplicate S3 events.
- The webhook **secret** is stored securely (AWS SSM Parameter Store / Secrets Manager) and read
  by the Lambda, not hardcoded.
- A documented setup note: the GitHub-side configuration and the **permission required**
  (repo `admin:repo_hook` / repo admin, or org owner for org webhooks).
- Must respond **2xx within ~10s** (GitHub's delivery timeout). Given the low event rate a
  synchronous S3 write is fine; if it ever risks the budget, accept-then-write-async.
- **Failure modes:** invalid signature (401), unparseable/oversized body (4xx), an unmapped
  event-name (→ default classification, not dropped), and an S3 write failure (5xx + logged with
  the delivery id). **Note:** GitHub does **not** auto-retry failed deliveries (only manual
  redelivery ≤3 days), so a lost delivery is backstopped by the poller, not an automatic retry;
  `X-GitHub-Delivery` dedupe still prevents a double-write on a manual redelivery.

### Notes / Open questions
- Resolved: reuse `@octokit/webhooks` v14.2.0 (pure ESM, Node ≥20, typed event payloads +
  `verifyAndReceive`); also pulls in `@octokit/webhooks-types` for payload typing in AWE-154.
- Webhook **registration** needs a *fine-grained* PAT `write:repo_hook` (per repo) or org-owner
  (org hook) — distinct from the classic PAT the poller uses; document both.
- Open: ping event (`X-GitHub-Event: ping`) handling — acknowledge 200 without writing.
- Open: per-repo vs per-org webhook secret strategy (one shared secret vs per-source).
- Depends on `webhook-ingest-infra` (AWE-155) and `github-event-mapping` (AWE-154).

> **Resolved in planning (2026-06-29):**
> - **HMAC API (user decision):** use the **low-level `verify(secret, rawBody, sig)` from
>   `@octokit/webhooks-methods@^6.0.0`** — async, timing-safe, no receiver/dispatcher. (The stub
>   named `@octokit/webhooks`' `verifyAndReceive`, which needs a full `Webhooks` instance with
>   `.on()` handlers we don't use; `verify` is the same primitive that package uses internally.)
>   Verify against the **raw body string** before any `JSON.parse` — never parse-then-re-stringify.
> - **The GitHub edge is a `WebhookIntegration`** (the AWE-155 registry contract), composing the
>   **pure** AWE-154 `githubToEvent` normalizer+transform inside its async `handle`. It owns auth,
>   dedupe, ping-ack, persist (via the injected `S3EventRepository`), and dedupe-record.
> - **`ping` → `ack`** (200, no write). Decided.
> - **Secret:** **one shared webhook secret** for v1, in **SSM Parameter Store (SecureString)** at
>   `/personal-events/github/webhook-secret`, read once per cold start and memoized across warm
>   invocations. (SSM standard tier is free and 4 KB is plenty; Secrets Manager only if rotation
>   is later needed. Per-source secrets are a future refinement.) The AWS-Parameters-and-Secrets
>   Lambda extension is an optional caching optimization, not required for v1.
> - **Dedupe store = S3 markers** (no new datastore; S3 stays source of record): a
>   `DeliveryDedupeRepository` does `HeadObject`/`PutObject` on `deliveries/github/{deliveryId}`
>   under a non-event prefix, with a **lifecycle rule expiring `deliveries/` after 7 days** (>
>   GitHub's 3-day manual-redelivery window). Record the delivery **only after** a successful
>   event persist, so a persist failure (5xx) can be retried/backstopped without being masked.
> - **Unmapped event-name is NOT a failure** — it classifies to the GitHub config `default`
>   (logged as unmapped) and is written. A *schema-invalid* body (malformed) → 4xx + captured log.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. Depends on
> AWE-155 (the ingest app + `WebhookIntegration` contract + `S3EventRepository` + the deployed
> API/Lambda + IAM role) and AWE-154 (`githubToEvent`, `loadGithubConfig`).

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
From `.agents/general.md`, `.agents/guidance/aws.md`, `.agents/guidance/logging.md`, `.agents/languages/typescript/*`:
- **Gather / Compute / Persist**: **Gather** = secret (SSM, memoized) + headers/raw body +
  dedupe `HeadObject`; **Compute** = `verify` (auth gate) → `JSON.parse` (post-verify) →
  `githubToEvent` (pure normalize+transform); **Persist** = `S3EventRepository.putEvents` +
  `DeliveryDedupeRepository.record`. Each phase in its own collaborator.
- **Repository pattern**: SSM access behind a `WebhookSecretRepository`; dedupe behind a
  `DeliveryDedupeRepository`; S3 events behind the AWE-155 `S3EventRepository` (injected). The
  `handle` method orchestrates; it makes **no** raw AWS SDK calls itself.
- **Module SRP**: secret repo / dedupe repo / the integration / the setup-doc are separate.
- **Security**: timing-safe `verify` against the **raw** body; parse JSON **only after** a valid
  signature; a missing or malformed signature header → `unauthorized` (401), nothing written, logged.
- **No if/else on a discriminator**: ping/dedupe/auth branches are early-return guards on
  distinct conditions (genuine predicate logic, allowed); the outcome→HTTP mapping stays a
  `Record` (in AWE-155).
- **Result/error types**: `verify` returns `boolean` (octokit) — wrap the auth decision in a
  typed step; everything else flows through `Either`. No throws across the boundary; catch SDK
  rejections into typed failures.
- **Logging** (`logging.md`): winston; **every** log line carries the `X-GitHub-Delivery` id +
  `eventName`; auth failures log the reason but **never** the secret or full signature;
  unmapped-event lines are `warn`; persist failures are `error` with the bucket/key.
- **No enums**, explicit return types, no trailing semicolons, `.ts` import extensions.
- **ADR**: reference the AWE-153 feature ADR; append a revision-log entry noting the
  HMAC-via-`webhooks-methods` and S3-marker-dedupe decisions.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `apps/webhook-ingest/src/webhook-integration.ts` (AWE-155) — Why: the `WebhookIntegration` /
  `WebhookOutcome` contract to implement.
- `apps/webhook-ingest/src/s3-event-repository.ts` + `src/registry.ts` (AWE-155) — Why: the
  injected repository and where to register `github`.
- `apps/webhook-ingest/infra` files `lambda.tf` (AWE-155) — Why: extend the IAM role with
  `ssm:GetParameter`; add the SSM parameter + the `deliveries/` lifecycle rule.
- `packages/github/src/index.ts` (AWE-154) — Why: `githubToEvent`, `loadGithubConfig`,
  the trigger/normalizer contracts.
- `@octokit/webhooks-methods` README — Why: `verify(secret, payload, signature)` async + timing-safe.
- `.agents/guidance/logging.md`, `.agents/guidance/aws.md` — full read (IAM least-privilege, structured logs).

### Files to create / change
**Ingest app (`apps/webhook-ingest/`):**
- `src/integrations/github/github-integration.ts` — `GithubWebhookIntegration implements WebhookIntegration`.
- `src/integrations/github/webhook-secret-repository.ts` — `WebhookSecretRepository` (SSM GetParameter, memoized).
- `src/integrations/github/delivery-dedupe-repository.ts` — `DeliveryDedupeRepository` (S3 Head/Put markers).
- `src/integrations/github/register.ts` — constructs deps and registers `github` into the registry.
- `src/integrations/github/setup.md` — operator setup note (webhook config + permissions + secret).
- Update `src/registry.ts` — register the github integration (or expose a `registerDefault()` the handler calls at init).
- Update `package.json` — add deps `@octokit/webhooks-methods@^6.0.0`, `@aws-sdk/client-ssm`.
- Co-located specs: `github-integration.spec.ts`, `delivery-dedupe-repository.spec.ts`, `webhook-secret-repository.spec.ts`.

**Terraform (`infra/personal-events/`):**
- `github-webhook.tf` — `aws_ssm_parameter` (`type = "SecureString"`, placeholder value,
  `lifecycle { ignore_changes = [value] }`); extend the Lambda IAM policy with `ssm:GetParameter`
  on its ARN; add an S3 lifecycle rule expiring `deliveries/` after 7 days (or fold into the
  AWE-151 bucket lifecycle); pass `GITHUB_WEBHOOK_SECRET_PARAM` + `DELIVERY_PREFIX` to the Lambda env.

### Relevant documentation
- [`@octokit/webhooks-methods` (`verify`)](https://github.com/octokit/webhooks-methods.js) — Why: exact async timing-safe `verify(secret, rawBody, sig)`.
- [GitHub: validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) — Why: `X-Hub-Signature-256` scheme, raw-body requirement.
- [GitHub: webhook delivery headers + redelivery](https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers) — Why: `X-GitHub-Event`/`X-GitHub-Delivery`; no auto-retry, ≤3-day manual redelivery.
- [Creating webhooks + required permissions](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks) — Why: repo `admin:repo_hook` / org-owner for the setup note.
- [SSM Parameter Store SecureString from Lambda](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-securestring.html) — Why: `GetParameter` WithDecryption + IAM.

### Patterns to follow
- **The integration (`handle`)** — guards then G-C-P:
  ```ts
  export class GithubWebhookIntegration implements WebhookIntegration {
    source = "github"
    constructor(
      public secret: WebhookSecretRepository,
      public dedupe: DeliveryDedupeRepository,
      public events: S3EventRepository,
      public compiled: CompiledConfig,
      public clock: { nowIso(): string },
      public log: Logger
    ) {}
    handle = async (req: RawRequest): Promise<WebhookOutcome> => {
      const sig = req.headers["x-hub-signature-256"]
      const secret = await this.secret.get()
      if (!sig || !(await verify(secret, req.rawBody, sig))) {
        this.log.warn("github signature rejected", { deliveryId: req.headers["x-github-delivery"] })
        return { status: "unauthorized" }
      }
      const eventName = req.headers["x-github-event"] ?? ""
      if (eventName === "ping") return { status: "ack" }
      const deliveryId = req.headers["x-github-delivery"] ?? ""
      if (await this.dedupe.seen(deliveryId)) { this.log.info("duplicate delivery", { deliveryId }); return { status: "ack" } }
      const parsed = parseJson(req.rawBody)                      // Either<unknown, Error>, post-verify
      if (Either.isLeft(parsed)) return { status: "bad-request", reason: "invalid json" }
      const event = githubToEvent(this.compiled)({ eventName, deliveryId, receivedAt: this.clock.nowIso(), raw: parsed.right })
      if (Either.isLeft(event)) { this.log.warn("github unprocessable", { deliveryId, eventName, reason: event.left }); return { status: "bad-request", reason: "unprocessable" } }
      const put = await this.events.putEvents([event.right])
      if (put.status === "failure") { this.log.error("github s3 put failed", { deliveryId, error: put.error }); return { status: "server-error" } }
      await this.dedupe.record(deliveryId)                       // only after successful persist
      return { status: "events", count: 1 }
    }
  }
  ```
- **Secret repo (memoized SSM)** — one network read per cold start:
  ```ts
  export class WebhookSecretRepository {
    cached: Promise<string> | undefined
    constructor(public ssm: SSMClient, public paramName: string) {}
    get = (): Promise<string> => (this.cached ??= this.fetch())
    fetch = async (): Promise<string> => {
      const out = await this.ssm.send(new GetParameterCommand({ Name: this.paramName, WithDecryption: true }))
      return out.Parameter?.Value ?? Promise.reject(new Error(`missing secret ${this.paramName}`))
    }
  }
  ```
- **Dedupe repo (S3 markers)** — `seen` = HeadObject exists; `record` = PutObject a tiny marker:
  ```ts
  seen = async (id: string): Promise<boolean> =>
    this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}/${id}` }))
      .then(() => true).catch(e => e.name === "NotFound" ? false : Promise.reject(e))
  ```
  (Differentiate a genuine `NotFound` from other errors — a transient S3 error must not be read
  as "not seen" and silently allow a dup; reject so the handler 5xxes and the delivery retries.)
- **Unmapped events**: `githubToEvent` returns a `Right` (classified to `default`) — these are
  written, not dropped; log `warn` when the resolved rule was the fallback (the normalizer/transform
  can surface "used default" or the integration infers it).

### Codebase irregularities to ignore
- The stub Notes say "reuse `@octokit/webhooks` `verifyAndReceive`" and cite
  `@octokit/webhooks-types`; the **resolved decisions** are low-level `@octokit/webhooks-methods`
  `verify` and (in AWE-154) `@octokit/openapi-webhooks-types`. Follow the Plan.

### Step-by-step tasks

#### CREATE `webhook-secret-repository.ts` + `delivery-dedupe-repository.ts`
- **IMPLEMENT**: memoized SSM secret read; S3 marker `seen`/`record` with strict `NotFound` handling.
- **GOTCHA**: a non-`NotFound` S3 error in `seen` must **reject** (→ 5xx), never return `false`.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test webhook-secret-repository delivery-dedupe-repository`

#### CREATE `github-integration.ts`
- **IMPLEMENT**: the `WebhookIntegration` above; `verify` from `@octokit/webhooks-methods`.
- **GOTCHA**: verify the **raw** body string; `JSON.parse` only after a valid signature; never log the secret/signature.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test github-integration`

#### CREATE `register.ts` + wire into `registry.ts`
- **IMPLEMENT**: construct the repos (SSM client, S3 client, injected `S3EventRepository`),
  `loadGithubConfig` (fail fast if the bundled config is invalid), register under `"github"`.
- **GOTCHA**: build the clients once at module init (warm-invocation reuse), not per request.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest build`

#### EXTEND Terraform (`github-webhook.tf`)
- **IMPLEMENT**: SSM SecureString param (placeholder + `ignore_changes`), IAM `ssm:GetParameter`,
  `deliveries/` lifecycle expiry, Lambda env vars.
- **GOTCHA**: do **not** put the real secret in Terraform state — set it out-of-band:
  `aws ssm put-parameter --name /personal-events/github/webhook-secret --type SecureString --value <secret> --overwrite`.
- **VALIDATE**: `terraform -chdir=infra/personal-events plan` clean; re-plan no drift.

#### WRITE the operator setup note (`setup.md`)
- **IMPLEMENT**: how to add the webhook in GitHub (URL `https://hooks.…/github`, content-type
  `application/json`, the secret, events to send), the **permission** needed (repo
  `admin:repo_hook`/repo admin, or org owner), and the fine-grained PAT `write:repo_hook` if
  registering via API.
- **VALIDATE**: `test -f apps/webhook-ingest/src/integrations/github/setup.md`

### Testing strategy
- **Unit** (vitest): `github-integration.handle` over the full outcome matrix using a **real
  HMAC** computed with `@octokit/webhooks-methods` `sign` over an AWE-154 exemplar body —
  - valid signature + mapped event → `events` (repo called once, dedupe recorded after);
  - valid signature + **unmapped** event → `events` (default classification, written, warn logged);
  - **invalid/missing** signature → `unauthorized` (nothing written, dedupe untouched);
  - `ping` → `ack`;
  - duplicate delivery (dedupe `seen` true) → `ack` (no second write);
  - malformed JSON (but valid sig) → `bad-request`;
  - S3 put failure → `server-error` and dedupe **not** recorded.
  Mock the SSM/S3 clients; use the real `verify`/`sign` (no crypto mocks).
- **Integration** (deploy-gated, real AWS): post a signed payload to `https://hooks.…/github`,
  assert an object lands under the event prefix and a marker under `deliveries/github/`; re-post
  the same delivery id → no second event object (dedupe). Tear down by key.
- **Edge cases**: signature present but wrong secret → 401; body whose JSON is valid but fails
  the AWE-154 schema → `bad-request` + captured log; `X-GitHub-Delivery` missing → treated as
  un-dedupable (log + still process, or 4xx — assert the chosen behavior).

### Validation commands
- Level 1: `pnpm --filter @personal-events/webhook-ingest exec biome check src`
- Level 2: `pnpm --filter @personal-events/webhook-ingest typecheck`
- Level 3: `pnpm --filter @personal-events/webhook-ingest test`
- Level 4 (deploy-gated): `terraform -chdir=infra/personal-events apply`; signed `curl` smoke + dedupe re-post; confirm object in bucket.

## Plan refresh (2026-07-19) — what changed between planning and execution

| Planned assumption | Reality | Action |
| :--- | :--- | :--- |
| Dedupe markers live at `deliveries/github/{id}` **in the event bucket**, with a lifecycle rule expiring the prefix | **this would have been a catastrophic, silent bug** — see below | Markers live in a **separate operational-state bucket**; the prefix expiry moved with them |
| `S3EventRepository` and `registry.ts` are edited to register github | AWE-155 shipped a composition root and a value-based registry | `register.ts` is an `IntegrationFactory`; `registry.ts` is untouched |
| `githubToEvent` is called, then "the normalizer/transform can surface *used default*" | `githubToEvent` composes normalize+transform and returns only the event | The integration calls `normalizeWebhook` then `transform` explicitly, so it holds the **trigger** and asks `classify` whether a rule matched. Rebuilding the trigger from the body would have duplicated the normalizer's extraction rules |
| the ingest app has `src/s3-event-repository.ts` | it is in `packages/event-sink` | Injected, as AWE-155 built it |

### ⚠️ The story's dedupe-marker location was a silent-total-loss bug

The resolved decision put delivery markers under a `deliveries/` prefix **in the event bucket**.
`apps/desktop-notifier/src/poller.ts` lists that bucket with `ListObjectsV2` `StartAfter` and **no
prefix filter**, then `advanceMark` moves its high-water mark to the **highest key it saw**. Event
keys lead with a year, `"2026-…"`; `"deliveries/…"` starts with `d`, which sorts above every digit.

So the first poll that saw a single marker would push the consumer's mark above every event key that
will ever exist — and the desktop notifier would **never deliver another event**, permanently, with
no error anywhere. AWE-157's planned `state/github-poller.json` has exactly the same property
(`s` > `2`).

Both now live in `state.{env}.{system_domain}`, a second `hardened-bucket` with prefix expiry
(`infra/personal-events/state-bucket.tf`). The reasoning is recorded at three sites so it cannot be
"simplified" back: the Terraform file, `delivery-dedupe-repository.ts`'s docblock, and
`infra/README.md` § "Two buckets, and why they must stay two". A spec asserts the repository writes
to the state bucket.

This is **not** the same defect as the open delivery-semantics question — it is a new one this story
would have introduced, and it is fixed rather than recorded.

### Other design decisions taken during implementation

- **A failed secret read is not cached.** The plan's `this.cached ??= this.fetch()` memoizes the
  rejected promise, so one transient SSM blip would make the function reject **every** delivery until
  AWS recycled the environment — and a rejected delivery is a 401 GitHub never retries, i.e. silent
  permanent loss. The memo is cleared on failure; a spec pins it.
- **An empty secret is rejected.** A SecureString sitting at Terraform's placeholder, or blanked,
  would otherwise be used to verify every signature.
- **A missing `X-GitHub-Delivery` is a 400, not a best-effort write.** The plan left this open
  ("log + still process, or 4xx — assert the chosen behavior"). Writing an event that cannot be
  deduped means an operator's redelivery silently doubles it; refusing is the honest answer, and
  nothing but GitHub posts to this route.
- **Ping is checked before dedupe**, so a ping does not burn a marker for an event that never
  existed; **dedupe is checked before any work**, so a redelivery costs one `HeadObject`.
- **An invalid mapping config disables the GitHub integration rather than crashing the function.** A
  config typo would otherwise take down every provider, including ones whose config is fine.
- **IAM is a second role policy**, not an edit to AWE-155's: the generic ingest's permissions and one
  integration's permissions have different reasons to change. It is scoped to the delivery prefix,
  not the whole state bucket — the ingest has no business reading a poller cursor.

## Deferred verification — NOT met under the code-and-dry-run fence

The fence forbids `terraform apply`, creating any AWS resource, registering a real webhook against a
real repository, and using a real credential. These criteria are therefore **unverified** — not
failed, untested.

| Acceptance criterion | Status | Command or step the user must run to close it |
| :--- | :--- | :--- |
| A configured GitHub webhook delivers an event that is HMAC-verified and written to S3 | **Unverified** | `terraform -chdir=infra/personal-events apply`, then steps 1–3 of `apps/webhook-ingest/src/integrations/github/setup.md`, then open a PR and look for `github delivery written` in `aws logs tail` |
| The webhook secret is stored in SSM and read by the Lambda | **Unverified** | `aws ssm put-parameter --name "$(terraform -chdir=infra/personal-events output -raw github_webhook_secret_parameter)" --type SecureString --value "$(openssl rand -hex 32)" --overwrite`, then confirm a signed delivery succeeds |
| An invalid signature is rejected with 401 and logged, against the deployed endpoint | **Unverified** | `curl -i -XPOST "$(terraform -chdir=infra/personal-events output -raw github_webhook_url)" -H 'X-GitHub-Event: push' -H 'X-Hub-Signature-256: sha256=deadbeef' -d '{}'` → expect 401 |
| `X-GitHub-Delivery` dedupe prevents a double write on a real redelivery | **Unverified** | GitHub → Settings → Webhooks → Recent Deliveries → **Redeliver**; expect `200 {"acknowledged":"duplicate delivery"}` and **one** object in the bucket |
| A 2xx is returned within GitHub's ~10 s delivery timeout | **Unverified** | read the `REPORT` line's `Duration` in the function's CloudWatch log after a real delivery |
| The `deliveries/` lifecycle rule actually expires markers after 7 days | **Unverified** | `aws s3api get-bucket-lifecycle-configuration --bucket "$(terraform -chdir=infra/personal-events output -raw state_bucket_name)"` |
| The permission required (repo `admin:repo_hook` / org owner) is what GitHub actually demands | **Unverified** | attempt the setup as a non-admin and confirm the Webhooks tab is absent — documented from GitHub's docs, not exercised |
| An S3 write failure surfaces as 5xx **and** leaves no dedupe marker, end to end | **Unverified** | temporarily remove the `WriteEvents` IAM statement, apply, deliver, then confirm 5xx and that **Redeliver** writes the event once the permission is restored |

**No AWS resource was created. No webhook was registered against any repository. No PAT or webhook
secret was requested, invented, or used. Nothing was applied or deployed.**

### What WAS verified

- **A real HMAC, end to end in the specs.** Signatures are produced by `@octokit/webhooks-methods`
  `sign` and checked by the same package's `verify` — no crypto is stubbed. A genuine signature
  passes; a signature from a different secret, a signature over a body altered afterwards, a
  malformed header, and a missing header are each rejected with nothing written and the dedupe store
  never consulted. Neither the secret nor the signature appears in any captured log record.
- **The full outcome matrix** over real exemplar bodies: mapped event → written and classified from
  config; unmapped event → written under the default with a `warn` naming the match key an operator
  would add; `ping` → ack, no write, no marker; redelivery → ack, no second write; malformed JSON →
  400; schema-invalid body → 400 with the offending field named; S3 failure → 5xx **and no marker
  recorded**; a non-`NotFound` dedupe error rejects rather than reading as "not seen".
- **A real, clean `terraform plan`** on a scratch copy with `backend.tf` removed:
  **`Plan: 32 to add, 0 to change, 0 to destroy`** — AWE-155's 24 plus the state bucket's six, the
  SSM parameter, and the second IAM role policy. `terraform validate` Success, `fmt -check` clean.
- **102 specs** in `apps/webhook-ingest` (52 from AWE-155 + 50 here).

### Validation actually run

| Level | Command | Result |
| :--- | :--- | :--- |
| 1 — style | `pnpm --filter @personal-events/webhook-ingest lint` | clean |
| 2 — types | `pnpm --filter @personal-events/webhook-ingest typecheck` | clean |
| 3 — specs | `pnpm --filter @personal-events/webhook-ingest test` | 102 passed |
| 4 — infra | `terraform fmt -check -recursive infra`, `validate` both roots, scratch `plan` | clean / Success / 32 to add |
