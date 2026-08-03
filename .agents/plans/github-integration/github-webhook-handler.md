---
id: AWE-156
title: GitHub webhook handler (signature verify → S3)
type: story
status: todo:backlog
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-03
---

# Story: GitHub webhook handler (signature verify → S3)

> **Restructured 2026-08-03.** Writes through F1's `@personal-events/s3-repository` (AWE-213) rather than a feature-local writer. The code sketches in `## Plan` were converted from `Promise` to `Effect` on 2026-08-03 per ADR `2026-08-03-0035-effect-as-default-idiom`; the surrounding task list still predates the restructure. Re-run `/plan-story` before executing.

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
> **Idiom:** all signatures below are `Effect` per ADR `2026-08-03-0035-effect-as-default-idiom`.
> Dependencies arrive as `Context.Tag` services provided by `Layer`, not constructor arguments;
> pure fallible helpers (`parseJson`, `githubToEvent`) stay `Either`. Raw `Promise` appears only in
> the Lambda `handler` export, via `Effect.runPromise`.

- **The integration (`handle`)** — guards then G-C-P. Every remaining typed failure is folded to a
  `WebhookOutcome` at the very end, because a webhook handler must *always* yield an HTTP status:
  ```ts
  export const makeGithubWebhookIntegration = Effect.gen(function* () {
    const secret = yield* WebhookSecretRepository
    const dedupe = yield* DeliveryDedupeRepository
    const events = yield* S3EventRepository
    const compiled = yield* GithubMappingConfig
    const clock = yield* Clock

    const handle = (req: RawRequest): Effect.Effect<WebhookOutcome> =>
      Effect.gen(function* () {
        const sig = req.headers["x-hub-signature-256"]
        const key = yield* secret.get
        if (!sig || !(yield* verifySignature(key, req.rawBody, sig))) {
          yield* Effect.logWarning("github signature rejected")
            .pipe(Effect.annotateLogs({ deliveryId: req.headers["x-github-delivery"] }))
          return { status: "unauthorized" } as const
        }
        const eventName = req.headers["x-github-event"] ?? ""
        if (eventName === "ping") return { status: "ack" } as const
        const deliveryId = req.headers["x-github-delivery"] ?? ""
        if (yield* dedupe.seen(deliveryId)) {
          yield* Effect.logInfo("duplicate delivery").pipe(Effect.annotateLogs({ deliveryId }))
          return { status: "ack" } as const
        }
        const parsed = parseJson(req.rawBody)                    // Either — pure, post-verify
        if (Either.isLeft(parsed)) return { status: "bad-request", reason: "invalid json" } as const
        const receivedAt = yield* clock.nowIso
        const event = githubToEvent(compiled)({ eventName, deliveryId, receivedAt, raw: parsed.right })
        if (Either.isLeft(event)) {
          yield* Effect.logWarning("github unprocessable")
            .pipe(Effect.annotateLogs({ deliveryId, eventName, reason: event.left }))
          return { status: "bad-request", reason: "unprocessable" } as const
        }
        yield* events.putEvents([event.right])                   // S3 failure fails the channel
        yield* dedupe.record(deliveryId)                         // only after successful persist
        return { status: "events", count: 1 } as const
      }).pipe(
        Effect.catchAll(cause =>
          Effect.logError("github webhook failed", cause)
            .pipe(Effect.as({ status: "server-error" } as const)))
      )

    return { source: "github", handle } as const
  })
  ```
  Note what the typed error channel removes: the old `if (put.status === "failure")` check is gone —
  a failed `putEvents` short-circuits to the `catchAll`, so it is impossible to forget to handle.
- **Secret repo (memoized SSM)** — `Effect.cached` replaces the hand-rolled promise memo and is
  fiber-safe, while keeping the one-network-read-per-cold-start property:
  ```ts
  export const WebhookSecretRepositoryLive = Layer.effect(
    WebhookSecretRepository,
    Effect.gen(function* () {
      const ssm = yield* SsmClient
      const paramName = yield* Config.string("GITHUB_WEBHOOK_SECRET_PARAM")
      const fetch = Effect.tryPromise({
        try: () => ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true })),
        catch: cause => new SecretFetchError({ paramName, cause })
      }).pipe(
        Effect.flatMap(out => out.Parameter?.Value
          ? Effect.succeed(out.Parameter.Value)
          : Effect.fail(new SecretMissingError({ paramName })))
      )
      return { get: yield* Effect.cached(fetch) } as const      // memoized, typed failure
    })
  )
  ```
- **Dedupe repo (S3 markers)** — `seen` = HeadObject exists; `record` = PutObject a tiny marker:
  ```ts
  seen: (id: string): Effect.Effect<boolean, DedupeError> =>
    Effect.tryPromise({
      try: () => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}/${id}` })),
      catch: cause => cause
    }).pipe(
      Effect.as(true),
      Effect.catchIf(isNotFoundError, () => Effect.succeed(false)),  // genuine 404 → not seen
      Effect.mapError(cause => new DedupeError({ id, cause }))       // anything else fails the channel
    )
  ```
  (Differentiate a genuine `NotFound` from other errors — a transient S3 error must not be read
  as "not seen" and silently allow a dup. With the typed error channel this becomes *structural*
  rather than a convention: only `NotFound` is caught to `false`; every other failure propagates to
  the handler's `catchAll`, yields a 5xx, and GitHub's manual redelivery is the recovery path.)
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
