---
id: AWE-155
title: Generic webhook ingest (API Gateway + Lambda)
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
pm-record: recRcU4JBh60KvdvB
pm-url: https://airtable.com/appnae8GXuj1rNVoQ/tblpJmL4dJ7Q4rw3U/recRcU4JBh60KvdvB
branch: feature/github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-31
---

# Story: Generic webhook ingest (API Gateway + Lambda)

> **Restructured 2026-08-03, re-planned 2026-08-31.** The Terraform this story creates was parked in the future-state area by AWE-215 — Terraform future-state quarantine during F1, so this is a **restore-and-wire** story rather than a greenfield one. Signatures are `Effect` per ADR `2026-08-03-0035-effect-as-default-idiom`.

## Definition

### User story
As the operator of personal-events
I want a generic, internet-facing webhook ingest endpoint backed by a Lambda that writes
canonical events to S3
So that any integration's webhook (GitHub first) has a reusable place to land, without each
integration standing up its own infrastructure.

### Acceptance criteria

- **AC-01** — Terraform provisions, per environment, an **API Gateway HTTP API** (payload format
  2.0) integrated with a **Lambda** (`nodejs24.x`, **not** VPC-attached) whose IAM role grants
  **only** `s3:PutObject` on the event bucket ARN and `ssm:GetParameter` +
  `kms:Decrypt` on the webhook-secret parameter. No wildcard resource ARNs.
- **AC-02** — The endpoint is fronted by a **CloudFront distribution** with an **AWS WAF Web ACL**
  attached (Web ACL created in `us-east-1` with `scope = "CLOUDFRONT"`), carrying the `aws.md`
  managed rule set — `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`,
  `AWSManagedRulesAmazonIpReputationList` — **plus** an explicit rate-limit rule. WAF logging is
  enabled to an S3 log destination with a 60-day expiry per `aws.md`.
- **AC-03** — **The origin cannot be reached around the WAF.** CloudFront injects a secret
  origin-verify header (value from SSM, never in Terraform state as plaintext); the Lambda
  rejects any request lacking the correct value with `403` before doing any other work. A direct
  `POST` to the raw `https://{api-id}.execute-api.{region}.amazonaws.com/...` URL therefore
  returns `403`, not `404` or `200`.
- **AC-04** — A **per-environment custom hostname** resolves and serves the endpoint:
  `hooks.dev.personal-events.fifthdimensionengineering.com` and
  `hooks.prod.personal-events.fifthdimensionengineering.com`, each backed by an ACM certificate in
  **`us-east-1`** (CloudFront's requirement) validated by DNS records in **that environment's own
  zone** from AWE-151 — IaC: S3 event bucket & delegated DNS, with the alias `A`/`AAAA` record in
  the same zone.
- **AC-05** — A **generic Lambda handler** routes a request to a **registered integration** by path
  (e.g. `/github`), hands it the raw request (headers + raw body), and maps its outcome to an HTTP
  status. The handler is integration-agnostic: it contains **no** provider names, **no** signature
  verification, and **no** classification. This story ships the registry **empty**, so every POST
  to an unregistered path returns `404`; GitHub registers itself in AWE-156 — GitHub webhook
  handler (signature verify → S3).
- **AC-06** — **Persistence goes through the single existing Repository.** The handler and its
  integrations obtain `put` from the `EventRepository` `Context.Tag` (`@personal-events/core`,
  AWE-153 — Core layer contracts), provided by the `S3EventRepositoryLayer` from
  `@personal-events/s3-repository` (AWE-213 — S3 event repository & push CLI). **No new S3 write
  path, no new event-writing package, and no direct `@aws-sdk/client-s3` use outside that layer.**
- **AC-07** — **Raw body integrity is preserved.** The handler passes the exact request bytes
  through to the integration (base64-decoded only when `isBase64Encoded` is true), never
  JSON-parsing and re-serialising first, because AWE-156's HMAC signs the exact bytes. A test
  asserts a body with unusual-but-valid whitespace and Unicode survives byte-identical.
- **AC-08** — **Effect throughout**: every effectful function returns `Effect`; pure fallible
  helpers return `Either`; a raw `Promise` appears **only** in the exported Lambda `handler`, via
  `Effect.runPromise` (per `CLAUDE.md`).
- **AC-09** — **Logging is Effect's `Logger`, not winston.** Every record carries `level`, `env`,
  `timestamp` (ms), `service` (`webhook-ingest`) and the request id from
  `event.requestContext.requestId`, emitted as JSONL to the CloudWatch stream per
  `.agents/guidance/logging.md`. **The webhook secret and the origin-verify value are never
  logged**, at any level.
- **AC-10** — `terraform fmt -check`, `validate` and `plan` are clean for every environment root,
  and a second `plan` after `apply` reports **no drift** — including no perpetual diff on the
  CloudFront distribution or the WAF Web ACL.
- **AC-11** — **Failure modes**, each logged with the offending value and mapped to the right
  status: unroutable path → `404`; missing/incorrect origin-verify header → `403`; malformed
  request body → `400`; **S3 write failure → `5xx`** (so the sender can redeliver — GitHub does
  not auto-retry, making this load-bearing); missing SSM parameter → `5xx` with a message naming
  the parameter; IAM denial → `5xx` with the denied action and resource named.
- **AC-12** — Guidance conformance: G-C-P separation across distinct modules, Repository pattern
  (no SDK above the boundary), `Record` lookups rather than `if`/`else if` on a discriminator, no
  accumulator loops, no enums, explicit return types. Verified by `biome` + `typecheck`.

### Notes / Open questions

- **Decisions taken 2026-08-31 (user-confirmed), superseding the 2026-06-29 planning notes:**
  1. **Endpoint shape: HTTP API + CloudFront + WAF.** AWS WAF **cannot** attach to an API Gateway
     HTTP API — it supports REST APIs, CloudFront, ALB, AppSync, Cognito, App Runner, Amplify and
     Verified Access only ([AWS WAF resource
     types](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-aws-waf.html)).
     Fronting the HTTP API with CloudFront is the AWS-documented workaround and keeps HTTP API
     pricing. This **replaces** the prior note that "WAF is out of scope for v1", which was an
     unrecorded deviation from `aws.md`.
  2. **Lambda is not VPC-attached** — a **recorded, deliberate deviation** from `aws.md`'s "Lambda
     should always be provisioned on a VPC". The function's only dependencies are S3 and SSM, both
     reachable over AWS public endpoints with its IAM role; a VPC would require either a NAT
     gateway (~$32/month) or interface endpoints for no security gain, since there is no private
     network resource to reach. Revisit if the ingest ever needs a database or internal service.
  3. **Per-environment hostnames** `hooks.dev.…` / `hooks.prod.…`, each in its own AWE-151 zone.
- **Running cost is non-trivial and should be understood before applying.** A WAF Web ACL is
  approximately **$5/month plus ~$1/rule/month**, so the four-rule set above lands near
  **$10/month per environment** — the largest recurring cost in the system, exceeding the hosted
  zones. Two rule groups × two environments doubles it. *(Pricing from general knowledge, not
  measured — confirm against the AWS pricing page before applying.)* If that is unwelcome,
  attaching WAF to **production only** is a reasonable variation, but it must be recorded as a
  deviation rather than silently applied.
- **The prior plan's `packages/event-sink/` is deleted from this story.** It defined a second
  `S3EventRepository` with `Promise`-returning `putEvents`, duplicating AWE-213 — S3 event
  repository & push CLI and contradicting the feature's own cross-story contract that one Persist
  boundary exists. Its stated justification — sharing the write path with AWE-157 — GitHub
  activity poller — is void, because AWE-157 is `todo:abandoned`. AC-06 replaces it.
- **The prior plan named `@personal-events/integration-core` and its `SourceAdapter` / `transform` /
  `compileMappingConfig` exports.** AWE-153 — Core layer contracts was re-scoped and moved to
  `minimal-event-pipeline`; it now exports `Transformer<Raw>`, `classify`, `NormalizedEvent`, the
  `EventRepository` tag and the typed error classes. All references below use the current names.
- **`WebhookIntegration` remains the registry's element type, not the bare `Transformer`.** A
  webhook edge needs authentication (HMAC), idempotency (delivery dedupe) and ack-only cases
  (GitHub `ping`) that a *pure* transformer cannot express. The integration composes the pure
  transformer **inside** its `handle`, keeping the handler a thin router and `core` provider-agnostic.
- **This story requires a production write** to prove AC-02 through AC-04 and AC-10 — creating a
  CloudFront distribution, a WAF Web ACL, an ACM certificate, an HTTP API and a Lambda. The
  approval question is in the Acceptance evidence design below and is **not yet granted**; it must
  be asked at the start of this feature's execution. It is unrelated to the AWE-151/AWE-213
  approvals granted on 2026-08-31, which covered only the `minimal-event-pipeline` resources.
- Depends on **AWE-151 — IaC: S3 event bucket & delegated DNS** (environment zones, bucket,
  `us_east_1` provider alias), **AWE-153 — Core layer contracts** (the `EventRepository` tag),
  **AWE-213 — S3 event repository & push CLI** (the layer that satisfies it) and **AWE-149 —
  Monorepo & tooling bootstrap** (the `apps/*` build shape). **AWE-156 — GitHub webhook handler**
  consumes this story's registry; it is not required by it.

## Plan

> Validate the real exported surface of `@personal-events/core` and `@personal-events/s3-repository`
> before writing code — the prior version of this plan named symbols that no longer exist. Do not
> restate the user story.

### Decisions resolved during planning

- **Terraform lives in `infra/modules/` + `infra/environments/{development,production}/`**, the
  layout AWE-215 — Terraform future-state quarantine establishes and AWE-151 extends. The prior
  plan's `infra/personal-events/` root was rejected on 2026-08-31 and does not exist.
- **CloudFront's origin is the HTTP API's default `execute-api` endpoint**, not an API Gateway
  custom domain. This removes the regional ACM certificate, `aws_apigatewayv2_domain_name` and
  `aws_apigatewayv2_api_mapping` entirely — one certificate (us-east-1, for CloudFront) instead of
  two. The cost is that the `execute-api` URL stays publicly resolvable, which is precisely why
  AC-03's origin-verify header is mandatory rather than optional.
- **The `us_east_1` provider alias in `infra/modules/provider.tf` is retained and now load-bearing**
  — CloudFront certificates and `scope = "CLOUDFRONT"` WAF Web ACLs must both be created there.
  (AWE-151's plan notes the alias may be dead after the quarantine; this story is what revives it.)
- **Packaging: tsup bundle → `data "archive_file"` → `aws_lambda_function`.** No container image.
  `noExternal: [/.*/]` so the AWS SDK is bundled and the deployed version cannot drift from the
  tested one.
- **The registry ships empty.** AC-05 is provable with a **stub `WebhookIntegration`** in tests;
  the deployed handler legitimately 404s every POST until AWE-156 lands. This is deliberate, not a
  gap.
- **The origin-verify secret and the webhook secret are two different SSM parameters** with
  different lifecycles: the origin-verify value is infrastructure-internal and owned by this story;
  the GitHub webhook HMAC secret is owned by AWE-156. Conflating them would couple a rotation of
  one to the other.

### Acceptance evidence design

- **AC-03 (origin cannot be bypassed)** — the security-critical criterion.
  - *Defining input property*: a request sent to the **raw `execute-api` URL**, bypassing
    CloudFront entirely — not a CloudFront request with the header stripped.
  - *Direct assertions*: HTTP `403`, and the CloudWatch log records a rejection **without** echoing
    the expected or received secret value.
  - *Evidence command*: `bash infra/scripts/verify-ingest-origin.sh`
  - *Counterexample*: the same request **through** CloudFront returns `404` (unregistered path),
    proving the 403 comes from the origin check and not from the path being unroutable. Without
    this pairing a totally-broken endpoint would appear to pass.
  - *Environment*: production AWS.
- **AC-02 (WAF actually attached and enforcing)**
  - *Defining input property*: a request whose shape a managed rule blocks, plus a burst exceeding
    the rate limit.
  - *Direct assertions*: `aws wafv2 get-web-acl` shows the four rules; a request carrying an
    obvious SQLi/XSS probe string returns `403` from CloudFront; the WAF log destination receives a
    record.
  - *Evidence command*: `bash infra/scripts/verify-ingest-waf.sh`
  - *Counterexample*: assert a **benign** request is *not* blocked — a Web ACL in `Block`-everything
    mode would otherwise pass a "was it blocked?" check trivially.
- **AC-06 (single Persist boundary)**
  - *Direct assertions*: no `@aws-sdk/client-s3` import anywhere in `apps/webhook-ingest`, and no
    package named `event-sink` exists.
  - *Evidence command*:
    `! rg -n '@aws-sdk/client-s3' apps/webhook-ingest/src && ! test -d packages/event-sink`
  - *Counterexample*: this is the static half; the behavioural half is that the handler test
    provides `S3EventRepositoryLayer` and observes `put` being called — proving it goes *through*
    the tag rather than merely not importing the SDK.
- **AC-07 (raw body integrity)**
  - *Defining input property*: a body containing significant whitespace, a trailing newline, and
    multi-byte UTF-8 — the things a parse/re-stringify round-trip destroys.
  - *Direct assertions*: the bytes the stub integration receives are identical to the bytes sent.
  - *Evidence command*: `pnpm --filter @personal-events/webhook-ingest test -- raw-body-integrity`
  - *Counterexample*: include a body whose re-serialisation would differ only in key order —
    a naive implementation passes a simple `{"a":1}` case and fails this one.
- **AC-11 (failure modes) — complete-set inventory.** The criterion says *each*, so the supported
  set is enumerated and each member executed: unroutable path, missing origin header, wrong origin
  header, malformed body, S3 write failure, missing SSM parameter, IAM denial. **7 cases**, table-
  driven, with a guard asserting the table length so the inventory cannot silently shrink.
- **AC-09 (secrets never logged)**
  - *Evidence command*: `pnpm --filter @personal-events/webhook-ingest test -- no-secret-logging`
  - *Direct assertions*: with a sentinel secret value injected, the captured Effect log output
    contains the sentinel **zero** times across every failure path in the AC-11 inventory.

**Production-write approval question — REQUIRED, NOT YET GRANTED. Ask at the start of this
feature's execution:**

> AWE-155 — Generic webhook ingest cannot be verified without creating public infrastructure. May
> I run `terraform apply` against AWS account `269378281721` to create, per environment: an API
> Gateway HTTP API, a Lambda function and its IAM role, a CloudFront distribution, an ACM
> certificate in `us-east-1` (with DNS-validation records written into the AWE-151 environment
> zone), a WAF Web ACL with four rules, an SSM parameter holding the origin-verify secret, and a
> WAF log bucket? This creates a **publicly reachable internet endpoint** and adds roughly
> **$10/month per environment** in WAF charges. Rollback is `terraform destroy`; note CloudFront
> distributions take 15–20 minutes to disable and delete.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Layering** (ADR `2026-08-03-0028-layered-architecture`): the handler is a **Controller**. It
  performs no classification and knows no provider. Foreign shapes stop at the integration's
  transformer; S3 lives behind the `EventRepository` tag.
- **Gather / Compute / Persist** (`.agents/general.md`), in separate modules: **Gather** =
  `raw-request.ts` (parse the API GW v2 event, base64-aware); **Compute** = registry lookup and
  the integration's own pure pipeline; **Persist** = `EventRepository.put` plus
  `outcome-response.ts` serialising the HTTP reply.
- **Effect vs Either vs Promise** (`CLAUDE.md`): `Effect` for anything effectful, `Either` for pure
  fallible code, raw `Promise` **only** at the exported `handler`.
- **Logging** — Effect's `Logger`, not winston (see the Logging row in `CLAUDE.md`). Format rules
  from `.agents/guidance/logging.md` still bind.
- **No `if`/`else if` on a discriminator**: route→integration and outcome→status are `Record`
  lookups.
- **No accumulator loops**: building `Event[]` and issuing puts uses `map` / `Effect.forEach`,
  never a `for` filling an array.
- **`aws.md`**: least-privilege IAM (no wildcard resources), Terraform for all IaC, Node 24 async
  handler, WAF on the exposed endpoint, WAF logging to S3 with a 60-day TTL. **The no-VPC choice
  is a recorded deviation** — state it in the ADR revision log, do not leave it implicit.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md` (AWE-151) — Why: the
  `infra/modules/` + `infra/environments/{shared,development,production}/` layout, the environment
  zone id output the ACM validation and alias records attach to, `event_bucket_name`/ARN, and the
  `backend "s3" { use_lockfile = true }` state.
- `.agents/plans/minimal-event-pipeline/s3-repository-and-push-cli.md` (AWE-213) — Why:
  `S3EventRepositoryLayer`, the exact `put`/`putAll` signatures, and the conditional-put
  `AlreadyExists` semantics this handler must not treat as an error.
- `.agents/plans/minimal-event-pipeline/core-layer-contracts.md` (AWE-153) — Why: the
  `EventRepository` `Context.Tag`, `PutOutcome`, `EventWriteError`, `Transformer<Raw>`,
  `NormalizedEvent`. **Read the real exports; the prior plan named symbols that no longer exist.**
- `.agents/plans/github-integration/github-webhook-handler.md` (AWE-156) — Why: the consumer of
  this story's registry, and the owner of the HMAC secret this story must *not* also define.
- `.agents/guidance/deployment-environments/aws.md` — Why: the WAF managed-rule list, the
  logging-bucket naming convention, and the VPC rule this story deviates from.
- `.agents/guidance/api-servers.md` — Why: the Controller→Service→Repository model. **Map it, do
  not import NestJS** — that file is NestJS-shaped and this is a Lambda.
- `infra/modules/provider.tf` — Why: the existing `us_east_1` aliased provider that the CloudFront
  certificate and the `CLOUDFRONT`-scope Web ACL require.

### Files to create / change

**Lambda app (`apps/webhook-ingest/`):**
- `package.json` — `@personal-events/webhook-ingest`; deps `effect`,
  `@personal-events/event-model`, `@personal-events/core`, `@personal-events/s3-repository`
  (all `workspace:*`), `@aws-sdk/client-ssm`; dev `@types/aws-lambda`, `tsup`, `vitest`.
  **No `winston`. No `@aws-sdk/client-s3`** — S3 access belongs to `s3-repository`.
- `tsconfig.json`, `tsup.config.ts` (`entry: ["src/handler.ts"]`, `format: ["esm"]`,
  `target: "node24"`, `noExternal: [/.*/]`), `vitest.config.ts`.
- `src/handler.ts` — the exported Lambda handler; the **only** place a raw `Promise` appears.
- `src/raw-request.ts` — `parseRawRequest(event): RawRequest` (base64-aware, byte-preserving).
- `src/origin-verify.ts` — the AC-03 gate: compare the configured secret to the request header in
  constant time, before any routing.
- `src/webhook-integration.ts` — the `WebhookIntegration` contract and the `WebhookOutcome` union
  (`events` / `ack` / `unauthorized` / `bad-request` / `server-error`).
- `src/registry.ts` — `integrationFor(path)`; **ships empty**.
- `src/outcome-response.ts` — pure `Record`-keyed `outcomeToResponse`.
- `src/secret.ts` — the SSM secret repository (`Effect`-returning), the only `@aws-sdk/client-ssm`
  touch-point.
- `src/config.ts` — env schema (`EVENT_BUCKET`, `ENV`, `ORIGIN_VERIFY_PARAM`) via effect `Schema`.
- `src/logger.ts` — the Effect `Logger` layer (JSONL, `service: "webhook-ingest"`, request id).
- Co-located `*.spec.ts` for each of the above.

**Terraform (`infra/modules/`):**
- `lambda.tf` — restored from `infra/future-state/`, reduced: `archive_file`, `aws_lambda_function`
  (`nodejs24.x`, **no `vpc_config`**), `aws_iam_role`, least-privilege `aws_iam_role_policy`,
  `aws_cloudwatch_log_group`.
- `apigateway.tf` — restored and reduced: `aws_apigatewayv2_api` (HTTP), `_integration` (AWS_PROXY,
  payload 2.0), `_route` (`POST /{integration}`), `_stage` (`$default`, auto-deploy, throttle),
  `aws_lambda_permission`. **No custom domain / api mapping** — CloudFront owns the hostname.
- `cloudfront.tf` — **new**: the distribution, its `execute-api` origin, the origin-verify custom
  header, and the alias to the per-environment hostname.
- `waf.tf` — **new**: `aws_wafv2_web_acl` (provider `aws.us_east_1`, `scope = "CLOUDFRONT"`) with
  the four rules, `aws_wafv2_web_acl_logging_configuration`, and its log bucket.
- `cert.tf` — restored from future-state and reduced to a **us-east-1** certificate for the
  environment hostname, DNS-validated in that environment's zone.
- `ssm.tf` — **new**: the origin-verify parameter (`SecureString`), value generated by
  `random_password` and **not** printed as a Terraform output.
- `variables.tf` / `outputs.tf` — add `ingest_subdomain` (default `hooks`), `lambda_dist_path`;
  output `ingest_url`, `ingest_function_name`, `cloudfront_distribution_id`.
- `infra/scripts/verify-ingest-origin.sh`, `infra/scripts/verify-ingest-waf.sh` — the AC evidence
  commands; `shellcheck`-clean.
- `infra/README.md` — extend the runbook: build the bundle **before** `apply`; CloudFront
  destroy takes 15–20 minutes.
- `docs/decisions/<...>/adr-revision-log.md` — append the no-VPC and CloudFront+WAF deviations to
  the ADR AWE-151 creates, rather than opening a new ADR.

### Relevant documentation

- [Use AWS WAF to protect your REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-control-access-aws-waf.html)
  — Why: establishes that WAF attaches to REST APIs, **not** HTTP APIs — the constraint driving
  the CloudFront hop.
- [Protect an HTTP API with WAF (AWS re:Post)](https://repost.aws/questions/QU0cc8yP29RYyFOB4Vx-uK_Q/protect-http-api-gateway-with-waf)
  — Why: the CloudFront-in-front workaround this story implements.
- [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
  — Why: the feature matrix behind keeping HTTP API and adding CloudFront.
- [HTTP API ↔ Lambda payload format 2.0](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
  — Why: `event.body` is `string | null`; `isBase64Encoded` semantics that AC-07 depends on.
- [Lambda TypeScript packaging](https://docs.aws.amazon.com/lambda/latest/dg/typescript-package.html)
  — Why: the bundle→zip path.
- [`aws_wafv2_web_acl`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/wafv2_web_acl)
  — Why: `scope = "CLOUDFRONT"` must be created in `us-east-1`; managed-rule-group statement shape.
- [`aws_cloudfront_distribution`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_distribution)
  — Why: custom origin headers (the AC-03 mechanism) and `web_acl_id` wiring.

### Patterns to follow

- **Thin handler — the only `Promise` in the app:**
  ```ts
  export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> =>
    Effect.runPromise(
      pipe(
        handleRequest(event),
        Effect.provide(AppLayer),
        Effect.catchAll(e => Effect.succeed(outcomeToResponse({ status: "server-error", detail: e })))
      )
    )
  ```
  `AppLayer` merges the Effect `Logger`, the SSM secret repository and
  `S3EventRepositoryLayer` from `@personal-events/s3-repository`.
- **Origin verification runs before routing**, and uses a timing-safe comparison:
  ```ts
  const verified = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  ```
  Guard the length first — `timingSafeEqual` throws on mismatched lengths.
- **Outcome→status as a `Record`**, never a chained `if`:
  ```ts
  const responders: Record<WebhookOutcome["status"], (o: WebhookOutcome) => Response> = {
    events: ok, ack: ok, unauthorized: unauthorizedResponse,
    "bad-request": badRequest, "server-error": serverError
  }
  ```
- **Persist through the tag, never the SDK:**
  ```ts
  const repo = yield* EventRepository
  yield* repo.putAll(events)
  ```
- **`AlreadyExists` is success.** `PutOutcome._tag === "AlreadyExists"` must map to `2xx`, not an
  error — a redelivered webhook that was already recorded is a correct no-op (AWE-213 AC-07).
- **Terraform**: least-privilege IAM with concrete ARNs; `random_password` + SSM `SecureString`
  for the origin-verify value, marked `sensitive` and never output.

### Codebase irregularities to ignore

- **The prior plan's `packages/event-sink/` and its `S3EventRepository`** — deleted from this
  story; AC-06 routes through AWE-213 instead. If you find that package, it should not exist.
- **`apps/desktop-notifier/src/s3-client.ts`**, cited by the prior plan as the S3 client pattern to
  mirror — that app was dissolved in the 2026-08-03 restructure into `local-sync-client` and
  `macos-notifications`, and mirroring an S3 client is exactly what AC-06 forbids.
- **`api-servers.md` is NestJS-shaped.** Map its Controller→Service→Repository model onto
  handler→integration→`EventRepository`; do not introduce NestJS.
- **`aws.md`'s multi-AZ ALB / EC2 guidance** is for long-running API servers and does not apply to
  a Lambda. Its **WAF and least-privilege IAM** rules do apply and are honoured.
- **The `hooks.personal-events.…` single hostname** in the prior plan's 2026-06-29 note predates
  the dev/prod split; AC-04 supersedes it.

### Step-by-step tasks

Execute in order.

#### CREATE `apps/webhook-ingest/` skeleton + config, logger, secret
- **IMPLEMENT**: package/tsconfig/tsup/vitest; effect-`Schema` env config; the Effect `Logger`
  layer; the SSM secret repository.
- **GOTCHA**: `noExternal: [/.*/]` so the zip is self-contained; **do not** add `winston` or
  `@aws-sdk/client-s3`.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest build && test -f apps/webhook-ingest/dist/handler.js`

#### CREATE `raw-request.ts` + `origin-verify.ts`
- **IMPLEMENT**: byte-preserving parse; the constant-time origin check that runs before routing.
- **GOTCHA**: guard buffer lengths before `timingSafeEqual`; never log either value.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test -- raw-body-integrity origin-verify`

#### CREATE `webhook-integration.ts` + `registry.ts` + `outcome-response.ts`
- **IMPLEMENT**: the contract, the empty registry, the `Record`-keyed responder map.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test -- outcome-response`

#### CREATE `handler.ts` wiring the layers
- **IMPLEMENT**: origin check → parse → route → `handle` → map outcome; provide `AppLayer`
  including `S3EventRepositoryLayer`; `Effect.runPromise` at the export only.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest test -- handler` (stub integration:
  each outcome maps to its status; unknown path → 404; missing origin header → 403)

#### RESTORE and reduce Terraform `lambda.tf` + `apigateway.tf` from future-state
- **IMPLEMENT**: `git mv` back from `infra/future-state/`, then strip: **no `vpc_config`**, no ALB
  logging, no NAT/subnet references; least-privilege IAM with concrete ARNs.
- **GOTCHA**: the parked files assume a VPC-resident Lambda; removing `vpc_config` without also
  removing the security-group and subnet variables leaves orphaned inputs.
- **VALIDATE**: `terraform -chdir=infra/environments/development validate`

#### CREATE `cert.tf` (us-east-1), `cloudfront.tf`, `waf.tf`, `ssm.tf`
- **IMPLEMENT**: us-east-1 certificate DNS-validated in the environment zone; CloudFront with the
  `execute-api` origin and the origin-verify custom header; the `CLOUDFRONT`-scope Web ACL with
  four rules plus logging; the SSM `SecureString`.
- **GOTCHA**: both the certificate **and** the Web ACL must use the `aws.us_east_1` provider alias
  — a `CLOUDFRONT`-scope Web ACL created in another region fails at apply, not at plan.
- **VALIDATE**: `terraform -chdir=infra/environments/development plan` completes; a second plan
  after apply reports no drift.

#### CREATE the verification scripts
- **IMPLEMENT**: `verify-ingest-origin.sh` (raw `execute-api` → 403; via CloudFront → 404) and
  `verify-ingest-waf.sh` (rules present; probe blocked; benign request allowed).
- **VALIDATE**: `shellcheck infra/scripts/verify-ingest-*.sh`

#### WRITE the ADR revision-log entries and the runbook
- **IMPLEMENT**: append the **no-VPC deviation** and the **CloudFront+WAF** decision (with the
  WAF-cannot-attach-to-HTTP-API rationale) to the AWE-151 ADR's revision log; extend
  `infra/README.md` with build-before-apply and the CloudFront teardown delay.
- **VALIDATE**: `rg -q 'no-VPC|not VPC-attached' docs/decisions/*/adr-revision-log.md`

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: reconcile against `.agents/general.md` + `typescript.md` + `CLAUDE.md`.
- **VALIDATE**: `pnpm --filter @personal-events/webhook-ingest exec biome check src`,
  `typecheck`, and `! rg -n '@aws-sdk/client-s3|winston' apps/webhook-ingest/src`

### Testing strategy

- **Unit (vitest + `@effect/vitest`)**: `parseRawRequest` (base64, plain, absent body, byte
  integrity), `origin-verify` (match, mismatch, absent, length-mismatch), `outcomeToResponse`
  (every `status`), `handler` with a stub `WebhookIntegration` and a test `EventRepository` layer,
  the AC-11 failure table, and the no-secret-logging assertion using a capturing `Logger`.
- **Integration (live, production)**: after apply — `verify-ingest-origin.sh` and
  `verify-ingest-waf.sh` against the real CloudFront hostname over HTTPS. Read-only probes are
  covered by execute's automatic authorization; the **apply itself** is the production write gated
  on the approval question above.
- **Edge cases**: unknown path; empty body; oversized body (rejected by API Gateway before Lambda —
  document the limit rather than testing it); IAM-denied `PutObject` → 5xx naming bucket and key;
  SSM parameter absent.
- **Skip inventory**: the two live scripts are the only deploy-gated suites and are enumerated
  here. If they do not run, the story is **blocked**, not passed. Expected unexpected-skip count is
  **0**.

### Validation commands

- Level 1 — Style: `pnpm --filter @personal-events/webhook-ingest exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/webhook-ingest typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/webhook-ingest test`
- Level 4 — Infra + live: `terraform -chdir=infra/environments/development plan -detailed-exitcode`,
  `bash infra/scripts/verify-ingest-origin.sh`, `bash infra/scripts/verify-ingest-waf.sh`
