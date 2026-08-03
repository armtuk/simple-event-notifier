---
id: AWE-155
title: Generic webhook ingest (API Gateway + Lambda)
type: story
status: todo:backlog
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-03
---

# Story: Generic webhook ingest (API Gateway + Lambda)

> **Restructured 2026-08-03.** The Terraform this story creates was parked in the future-state area by AWE-215 during F1, so this is now a **restore-and-wire** story rather than a greenfield one — restore only what is needed and re-verify against `.agents/guidance/deployment-environments/aws.md`. Signatures must be `Effect` per ADR `2026-08-03-0035-effect-as-default-idiom`. Re-run `/plan-story` before executing.

## Definition

### User story
As the operator of personal-events
I want a generic, internet-facing webhook ingest endpoint backed by a Lambda that writes
canonical events to S3
So that any integration's webhook (GitHub first) has a reusable place to land, without each
integration standing up its own infrastructure.

### Acceptance criteria
- Terraform (extending the AWE-151 `infra` project) provisions an **API Gateway HTTP API** + a
  **Lambda** with an IAM role permitted to `PutObject` into the event bucket, fronted by a
  custom domain under `personal-events.fifthdimensionengineering.com` (e.g. `hooks.…`) with an
  ACM certificate and the Route53 record in the project's delegated zone.
- A **generic Lambda handler** (TypeScript, in the monorepo) that: routes a request to a
  **registered integration** by path (e.g. `/github`), hands the raw request (headers + body)
  to that integration's `SourceAdapter`, and writes the resulting canonical event(s) to S3
  using the `event-model` key scheme. The handler is integration-agnostic — GitHub plugs in via
  AWE-156; an unknown route returns 404.
- The Lambda is built/bundled (tsup) and deployed via the Terraform pipeline; `terraform plan`
  is clean and re-plan shows no drift.
- Returns appropriate HTTP status codes (2xx accepted, 4xx client error) quickly; heavy work
  stays within Lambda limits.
- **Failure modes:** an unroutable path → 404; an S3 write failure → 5xx + logged (so GitHub
  retries); a malformed request body → 4xx; missing IAM permission surfaces clearly in logs.

### Notes / Open questions
- This is the **generic ingest** the user opted to build inside the GitHub feature; design it so
  later integrations register additional routes without infra changes per integration.
- Open: API Gateway **HTTP API vs REST API** (HTTP API is cheaper/simpler — likely choice);
  decide in `/plan-story`.
- Open: Lambda packaging in a turbo monorepo (tsup bundle + Terraform `archive_file` vs a
  container image) — decide in planning.
- Open: synchronous write-to-S3 in the handler vs. accept-then-async — start synchronous given
  the low event rate; revisit if latency/duplstacks matter.
- Depends on `bootstrap-and-iac` infra (AWE-151) for the Terraform project + delegated zone +
  bucket, and on `integration-framework` (AWE-153) for the dispatch/`SourceAdapter` interface.

> **Resolved in planning (2026-06-29):**
> - **API Gateway HTTP API** (not REST) — cheaper, simpler, payload format v2.0; sufficient for
>   webhook ingest.
> - **Packaging:** **tsup bundle → zip → Terraform `archive_file` → `aws_lambda_function`**
>   (AWS's recommended esbuild-class path; no container image). ESM output, `runtime = nodejs24.x`.
> - **Synchronous S3 write** in the handler (low event rate; a 5xx on write failure lets the
>   client/poller backstop). Revisit only if Lambda duration becomes a problem.
> - **Hostname:** `hooks.personal-events.fifthdimensionengineering.com`. (`.agents/guidance/aws.md`
>   suggests `{component}.{env}.{system}.{domain}`; this single-env personal system omits `env`.
>   If you want `hooks.prod.personal-events.…`, say so.)
> - **This story ships the generic skeleton with an empty integration registry** (or a single
>   `GET /healthz`). GitHub's integration + its route registration land in AWE-156 — so AWE-155's
>   acceptance is provable with a **stub `WebhookIntegration`** in tests; the deployed handler
>   404s every POST until AWE-156 registers `github`.
> - **Registry holds a `WebhookIntegration`, not the bare `SourceAdapter`.** A webhook source
>   needs an async edge — authentication (HMAC), idempotency (delivery dedupe), and ack-only
>   cases (GitHub `ping`) — that integration-core's *pure* `SourceAdapter` can't express. So the
>   ingest app defines `WebhookIntegration { source; handle(req): Promise<WebhookOutcome> }`; a
>   concrete integration (GitHub, AWE-156) composes the pure `SourceAdapter`/normalizer **inside**
>   `handle` and owns its own auth/dedupe deps (injected at registration). This keeps the handler
>   a thin router + outcome→HTTP mapper and keeps integration-core provider-agnostic.
> - **S3 writes go through one injected repository** (`S3EventRepository`) — the only place AWS
>   SDK S3 calls live (general.md Repository rule). The repository is constructed once and
>   **injected into each `WebhookIntegration`** at registration, so Persist stays in one class
>   while each integration orchestrates its own G-C-P pipeline. It lives in the shared
>   **`@personal-events/event-sink`** package so the AWE-157 poller reuses the identical write path.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. Depends on
> AWE-151 (`infra/personal-events` Terraform: bucket + delegated zone + remote state) and
> AWE-153 (`SourceAdapter` interface + `transform`). The Lambda is the first `apps/*` Lambda.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
From `.agents/general.md`, `.agents/guidance/aws.md`, `.agents/guidance/api-servers.md`,
`.agents/guidance/logging.md`, `.agents/languages/typescript/*`:
- **Gather / Compute / Persist** in the handler: **Gather** = parse the API GW v2 event into a
  raw request (headers + raw body, base64-aware); **Compute** = registry lookup → adapter
  `toNormalizedEvents` → `transform` → `Event[]` (pure); **Persist** = `S3EventRepository.putEvents`
  + serialize the HTTP response. Keep these in separate modules.
- **Repository pattern** (`general.md`, `api-servers.md`): **all** S3 access is inside
  `S3EventRepository`; the handler never touches `@aws-sdk/client-s3` directly.
- **Module SRP**: handler / registry / raw-request parser / repository / response builder /
  config / logger are separate files.
- **No if/else on a discriminator**: route→adapter and status selection are `Record` lookups.
- **No accumulator loops**: building `Event[]` from adapter output and S3 puts is `.map`/
  `Promise.all` (or sequential via `reduce` if ordering matters — here order is irrelevant, use
  `Promise.all`), never a `for` filling an array.
- **Result/error types**: internal functions return `Either`/typed results; the handler maps
  them to HTTP responses (the boundary that serializes — api-servers Persist phase).
- **Raw body integrity** (security): never JSON-parse-then-re-stringify before the adapter sees
  the body — the GitHub HMAC in AWE-156 signs exact bytes. The handler passes the raw string
  (base64-decoded only if `isBase64Encoded`) straight through.
- **Logging** (`logging.md`): winston, `import winston from "winston"`; every record carries
  `level`/`env`/`timestamp`/`service` + a `requestID` (use `event.requestContext.requestId`).
  JSON to the (CloudWatch) stream; include the offending value on errors.
- **AWS conventions** (`aws.md`): Terraform for all IaC; Route53 delegated zone; Lambda Node 24
  async handler; least-privilege IAM (only `s3:PutObject` on the event bucket ARN/prefix).
- **No enums**; **explicit return types**; no trailing semicolons; `.ts` import extensions.
- **ADR**: covered by the AWE-153 feature ADR — reference it (this story is the dual-path's
  webhook-ingest limb). If the hostname/HTTP-API choices warrant it, append a revision-log entry
  to that ADR rather than creating a new one.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/bootstrap-and-iac/infra-s3-and-dns.md` — Why: the exact `infra/personal-events/`
  layout, the delegated `aws_route53_zone` (child zone id output), the `event_bucket_name`/ARN
  outputs, the `backend "s3" { use_lockfile = true }` state, AWS provider `~> 6.0`,
  `required_version >= 1.11`.
- `.agents/plans/bootstrap-and-iac/monorepo-bootstrap.md` — Why: the `infra` turbo member
  (`plan`/`deploy`, `cache: false`, `passThroughEnv` AWS creds); tsup app build shape.
- `packages/integration-core/src/index.ts` (AWE-153) — Why: `SourceAdapter`, `transform`,
  `compileMappingConfig`, `type NormalizedEvent`.
- `packages/event-model/src/index.ts` (AWE-150) — Why: `buildKey(event)`, `type Event`.
- `.agents/guidance/aws.md`, `.agents/guidance/api-servers.md`, `.agents/guidance/logging.md` — full read.
- `apps/desktop-notifier/src/s3-client.ts` (AWE-152, if present) — Why: existing S3 client
  construction + credential-provider pattern to mirror (`@aws-sdk/client-s3`,
  `CredentialsProviderError` lives in `@smithy/property-provider`).

### Files to create / change
**Lambda app (`apps/webhook-ingest/`):**
- `package.json` — `@personal-events/webhook-ingest`; deps `effect`, `@aws-sdk/client-s3`,
  `winston`, `@personal-events/event-model`, `@personal-events/integration-core` (`workspace:*`);
  dev `@types/aws-lambda`, `tsup`, `vitest`. tsup: `entry: ["src/handler.ts"]`, `format: ["esm"]`,
  `target: "node24"`, `clean: true`, `noExternal: [/.*/ ]` (bundle everything for the zip).
- `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`.
- `src/handler.ts` — `export const handler: APIGatewayProxyHandlerV2` (thin G-C-P orchestrator).
- `src/raw-request.ts` — `parseRawRequest(event): { path, headers, rawBody }` (base64-aware).
- `src/webhook-integration.ts` — the `WebhookIntegration` interface (`source`, async
  `handle(req: RawRequest): Promise<WebhookOutcome>`) + the `WebhookOutcome` union
  (`events` → 2xx / `ack` → 2xx / `unauthorized` → 401 / `bad-request` → 4xx / `server-error` → 5xx).
- `src/registry.ts` — `IntegrationRegistry = Record<string, WebhookIntegration>`;
  `integrationFor(path)`. Ships **empty** here; AWE-156 registers `github`.
- `src/outcome-response.ts` — pure `outcomeToResponse(outcome): APIGatewayProxyResultV2`
  (Record-keyed on `outcome.status`).
- **Shared package `packages/event-sink/`** (`@personal-events/event-sink`) —
  `S3EventRepository.putEvents(events: readonly Event[]): Promise<PutEventsResult>`, the **single**
  S3 event-write implementation reused by **both** this Lambda and the AWE-157 poller (DRY — one
  Repository home for S3 event writes). The app depends on it (`workspace:*`); it is **not** an
  app-local file.
- `src/response.ts` — pure `ok()`/`notFound()`/`badRequest()`/`serverError()` (status + JSON body).
- `src/config.ts` — env (`EVENT_BUCKET_NAME`, `AWS_REGION`, `ENV`).
- `src/logger.ts` — winston factory (service `webhook-ingest`).
- `src/index.ts` — re-export `handler`.
- Co-located specs: `handler.spec.ts`, `raw-request.spec.ts`, `s3-event-repository.spec.ts`, `response.spec.ts`.

**Terraform (`infra/personal-events/`):**
- `lambda.tf` — `data "archive_file"` zipping `apps/webhook-ingest/dist`; `aws_lambda_function`
  (`runtime = "nodejs24.x"`, `handler = "handler.handler"`, `source_code_hash`,
  `environment { EVENT_BUCKET_NAME, ENV }`); `aws_iam_role` + `aws_iam_role_policy`
  (`s3:PutObject` on `${bucket_arn}/*`); `aws_cloudwatch_log_group`.
- `apigateway.tf` — `aws_apigatewayv2_api` (`protocol_type = "HTTP"`), `aws_apigatewayv2_integration`
  (AWS_PROXY, payload format 2.0), `aws_apigatewayv2_route` (`POST /{integration}`),
  `aws_apigatewayv2_stage` (`$default`, auto-deploy, throttle limits), `aws_lambda_permission`.
- `ingest-dns.tf` — `aws_acm_certificate` (regional, DNS validation), validation
  `aws_route53_record` in the delegated child zone, `aws_acm_certificate_validation`,
  `aws_apigatewayv2_domain_name` (`hooks.…`), `aws_apigatewayv2_api_mapping`, the `A`/alias
  `aws_route53_record` pointing at the domain's target.
- `variables.tf` / `outputs.tf` additions — `ingest_subdomain` (default `hooks`),
  `lambda_dist_path`; outputs `ingest_url`, `ingest_function_name`.
- `infra/personal-events/README.md` — append the build-before-apply runbook.

### Relevant documentation
- [API Gateway HTTP API ↔ Lambda integration (payload v2.0)](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html) — Why: `event.body` is `string|null`; `isBase64Encoded` semantics.
- [AWS Lambda TypeScript packaging (esbuild, nodejs24.x)](https://docs.aws.amazon.com/lambda/latest/dg/typescript-package.html) — Why: bundle→zip pattern.
- [Terraform `aws_apigatewayv2_*` + custom domain](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_domain_name) — Why: HTTP API custom domain + ACM + mapping.
- [`archive_file` data source](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) — Why: zip the bundle with a content hash for `source_code_hash`.

### Patterns to follow
- **Thin handler (route → delegate → map)**:
  ```ts
  export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const log = makeLogger(event.requestContext.requestId)
    const req = parseRawRequest(event)                       // Gather
    const integration = integrationFor(req.path)
    if (!integration) { log.warn("unroutable", { path: req.path }); return notFound() }
    const outcome = await integration.handle(req)            // the integration owns its G-C-P
    return outcomeToResponse(outcome)                        // pure status Record mapping
  }
  ```
  `WebhookOutcome` is `{ status: "events", count } | { status: "ack" } | { status: "unauthorized" }
  | { status: "bad-request", reason } | { status: "server-error" }`. The integration (GitHub,
  AWE-156) does auth → dedupe → normalize → `transform` → persist (via the injected
  `S3EventRepository`) inside `handle`, returning `server-error` if persist fails (→ 5xx). Here
  the registry is empty so every POST 404s — proven via a **stub `WebhookIntegration`** in tests.
- **Raw body (security-critical)**:
  ```ts
  export const parseRawRequest = (event: APIGatewayProxyEventV2) => ({
    path: event.pathParameters?.integration ?? "",
    headers: event.headers,
    rawBody: event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : (event.body ?? "")
  })
  ```
- **S3 repository (Persist, Record-keyed object key)**:
  ```ts
  export class S3EventRepository {
    constructor(public client: S3Client, public bucket: string) {}
    putEvents = async (events: readonly Event[]): Promise<PutEventsResult> => {
      const puts = events.map(e => this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: buildKey(e), Body: JSON.stringify(e), ContentType: "application/json"
      })))
      return Promise.all(puts).then(() => ({ status: "success" as const, count: events.length }))
        .catch(error => ({ status: "failure" as const, error }))
    }
  }
  ```
- **Response builders** are pure (status + JSON string) — unit-testable without the handler.
- **Terraform**: split-resource S3 style already established in AWE-151; least-privilege IAM
  (`s3:PutObject` only, on the bucket ARN); regional ACM cert in the API's region (HTTP API
  custom domains use REGIONAL endpoints — cert must be same-region, not us-east-1-pinned).

### Codebase irregularities to ignore
- `.agents/guidance/aws.md` prescribes WAF + multi-AZ ALB for *API servers*; a webhook-ingest
  HTTP API + Lambda is serverless — WAF is **out of scope for v1** (signature verification in
  AWE-156 is the real gate). Note throttle limits on the stage as the basic abuse guard.
- `api-servers.md` is NestJS-controller-shaped; map its Controller→Service→Repository model onto
  handler→(dispatch)→`S3EventRepository`, but do not introduce NestJS.

### Step-by-step tasks

#### CREATE `apps/webhook-ingest/` skeleton + config/logger/response
- **IMPLEMENT**: package/tsconfig/tsup/vitest; `config.ts`, `logger.ts`, `response.ts`.
- **GOTCHA**: tsup must **bundle** deps (`noExternal`) so the zip is self-contained; AWS SDK v3
  is available in the Lambda runtime but bundling it avoids version drift — bundle it.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest build && test -f apps/webhook-ingest/dist/handler.js`

#### CREATE shared `packages/event-sink/` (`S3EventRepository`)
- **IMPLEMENT**: the `@personal-events/event-sink` package (`S3EventRepository.putEvents` using
  `buildKey` + `PutObjectCommand`, returning a typed `PutEventsResult`). This is the shared S3
  write path for both the Lambda and the AWE-157 poller.
- **PATTERN**: the repository block above; the only S3 touch-point.
- **VALIDATE**: `pnpm --filter @personal-events/event-sink test`

#### CREATE `raw-request.ts` + `webhook-integration.ts` + `registry.ts` + `outcome-response.ts`
- **IMPLEMENT**: the parser (base64-aware); the `WebhookIntegration`/`WebhookOutcome` contract;
  the empty registry + `integrationFor`; the pure `outcomeToResponse`. Depend on
  `@personal-events/event-sink` for `S3EventRepository`.
- **PATTERN**: blocks above; repository is the only S3 touch-point; `outcomeToResponse` is a
  `Record<WebhookOutcome["status"], (o) => Response>` (no if/else).
- **GOTCHA**: an integration that returns `events` but whose persist fails must surface **5xx**
  (so a sender retries / the poller backstops) and **not** record dedupe — that contract is the
  integration's (AWE-156); here just ensure `WebhookOutcome`'s `server-error` maps to 5xx.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test raw-request outcome-response`

#### CREATE `handler.ts` + `index.ts`
- **IMPLEMENT**: the thin router — parse → `integrationFor` → `handle` → `outcomeToResponse`;
  404 on unknown route.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test handler` (stub
  `WebhookIntegration`: registered path → its outcome mapped (2xx/4xx/etc.); unknown path → 404)

#### CREATE Terraform `lambda.tf`
- **IMPLEMENT**: archive_file over `dist/`, function, IAM role + least-priv policy, log group.
- **GOTCHA**: `terraform plan/apply` requires the bundle to exist first — document and wire the
  `infra deploy` script to depend on the app `build` (turbo `^build`).
- **VALIDATE**: `pnpm --filter @personal-events/infra exec terraform -chdir=personal-events validate`

#### CREATE Terraform `apigateway.tf` + `ingest-dns.tf`
- **IMPLEMENT**: HTTP API, AWS_PROXY integration, `POST /{integration}` route, `$default` stage
  with throttling, lambda permission; ACM cert (DNS-validated in the child zone), domain name,
  api mapping, alias record.
- **GOTCHA**: ACM DNS-validation records and the alias record go in the **delegated child zone**
  (`personal-events.…`) referenced by its zone-id output from AWE-151, not the parent zone.
- **VALIDATE**: `terraform -chdir=infra/personal-events plan` is clean; a second `plan` shows **no drift**.

#### WIRE outputs + runbook
- **IMPLEMENT**: `ingest_url` output; README build→package→apply order.
- **VALIDATE**: `terraform -chdir=infra/personal-events output ingest_url` returns the `https://hooks.…` URL.

### Testing strategy
- **Unit** (vitest, no AWS): `parseRawRequest` (base64 + plain + missing body), `response`/
  `outcomeToResponse` builders (each `WebhookOutcome.status` → correct HTTP code), `handler` with
  a **stub `WebhookIntegration`** returning each outcome (and an unknown path → 404), and
  `S3EventRepository` against a mocked `S3Client.send` (success + thrown failure → typed failure result).
- **Integration** (real AWS, per `.agents/tests.md` real-API preference): after `terraform apply`,
  `curl -XPOST https://hooks.…/github` (no adapter yet → 404) and a stub-route smoke test that
  asserts an object lands in the bucket (tear down by key). Mark these as deploy-gated.
- **Edge cases**: unknown path → 404; empty body → 4xx (adapter rejects); IAM-denied PutObject →
  5xx + a log line naming the bucket/key; oversized body (API GW rejects pre-Lambda — documented).

### Validation commands
- Level 1: `pnpm --filter @personal-events/webhook-ingest exec biome check src`
- Level 2: `pnpm --filter @personal-events/webhook-ingest typecheck`
- Level 3: `pnpm --filter @personal-events/webhook-ingest test`
- Level 4 (infra): `terraform -chdir=infra/personal-events fmt -check && validate && plan` clean; post-apply `curl` smoke test.
