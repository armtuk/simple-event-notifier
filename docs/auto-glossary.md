# Project Glossary

Terms of art and non-standard acronyms used across this project's code, plans, and docs. Its
audience is anyone — human or agent — arriving without the project's accumulated context. This
file is **command-maintained** (`/update-glossary`, the planning commands, ADR authoring) but is
a normal tracked doc that a human may edit directly. The glossary **summarizes**; where a term
has a canonical definition elsewhere, the entry links there.

_Last updated: 2026-08-31 — extended by `/plan-story` for AWE-155 and AWE-161 with the webhook-ingest
vocabulary; earlier the same day for AWE-151, AWE-213 and AWE-214 with the
AWS substrate and push-path vocabulary. Previously: 2026-08-03 — seeded by `/plan-feature` for `event-push-cli`, then extended with the
layering vocabulary coined by ADR `2026-08-03-0028-layered-architecture`. A full `/update-glossary`
sweep has not yet been run, so coverage is currently limited to the event model, the push path, the
architectural layers, and the planning vocabulary they rely on._

## Terms of art
- **Acknowledged** — A boolean flag on an event, independent of *Handled*, that a client sets to
  record that a human has *seen* the event. One half of the triage workflow.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Alert** — One of the two `eventType` values. An event that **requires attention**, as opposed
  to a *Notification*. Which provider events are alerts is config-driven per integration; for a
  *Push* the caller states it explicitly.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Application Model** — The canonical internal shape — here the `Event` — that all business
  logic accepts and returns. Fully validated at every boundary crossing, so code above the
  *Repository* may treat its correctness as guaranteed. No third-party shape is ever an
  Application Model. *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Business Logic Service** — A layer-2 object holding the system's actual decisions
  (classification, priority, triage). Transits *Application Model* values only, performs no I/O,
  and receives its data pre-gathered.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Canonical event** — The normalized JSON object every producer writes and every consumer
  reads: `timestamp`, `eventType`, `priority`, `source`, `name`, `acknowledged`, `handled`,
  optional `workItem`, and a provider-specific `payload`. The system's single load-bearing
  contract — treated as a versioned interface.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/minimal-event-pipeline/event-model-package.md).
- **Command** — A directed request to a known recipient that causes an action, as distinct from an
  *event* (a published fact that consumers pull). Writing to the bucket is a `PushEvent` command;
  what lands in S3 is the resulting fact.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Conditional put** — An S3 `PutObject` issued with `IfNoneMatch: "*"`, used by the *Repository*
  so that re-pushing an already-recorded object key is a **no-op returning `AlreadyExists`**
  rather than an overwrite. This is what preserves the append-only history guarantee: an event
  already in the log is never silently replaced.
  *Canonical:* [AWE-213](../.agents/plans/minimal-event-pipeline/s3-repository-and-push-cli.md).
- **Controller / Handler** — The layer-1 entry point: the webhook Lambda handler, the push CLI's
  argv entry, the sync client's poll loop. Owns protocol concerns only — status codes, exit codes,
  deserialization — and contains no business logic.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Effect** — Both the library (`effect@^3`) and its core type `Effect<A, E, R>`: a description of
  a computation that succeeds with `A`, fails with `E`, or requires context `R`. In this project
  every function that performs I/O returns one; pure fallible code stays `Either`.
  *Canonical:* [ADR `2026-08-03-0035-effect-as-default-idiom`](decisions/2026-08-03-0035-effect-as-default-idiom/adr-body.md).
- **Entity Model** — The shape data takes *in a store*, as opposed to the *Application Model*. For
  this system the S3 object — its key plus JSON body — is the Entity Model of the event repository.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Environment zone** — A per-environment Route53 hosted zone named
  `{env-short}.{product}.{sld}` (e.g. `dev.personal-events.fifthdimensionengineering.com`),
  delegated from the *Product zone* by an `NS` record set. Each environment owns exactly one, and
  creates it from its own Terraform root.
  *Canonical:* [AWE-151](../.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md).
- **Event bucket** — The S3 bucket holding one environment's event log, named
  `events.{env-short}.{product-domain}`. Versioned, fully public-access-blocked, and configured to
  tier old objects but **never expire a current version** — because S3 is the system's permanent
  history, not a cache.
  *Canonical:* [AWE-151](../.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md).
- **Event model** — The shared package (`@personal-events/event-model`) that defines the
  *Canonical event* schema and the *Object-key codec*. Depended on by every producer and consumer
  so the contract exists exactly once.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/minimal-event-pipeline/event-model-package.md).
- **Functional area** — A durable component area of the system, catalogued in `system.md`. Sits
  **above** features: an area never completes, it accretes features over the system's life. Each
  feature points back to its area via `functional-area:` frontmatter.
  *Canonical:* [`system.md` → Functional areas](../.agents/plans/system.md).
- **Future-state** — The `infra/future-state/` area holding Terraform that is deliberately deferred
  (VPC, Lambda, API Gateway, certificates, ALB logging). Inert because Terraform loads `.tf` files
  only from the directory it is invoked on, never recursively.
  *Canonical:* [AWE-215](../.agents/plans/minimal-event-pipeline/terraform-future-state-quarantine.md).
- **Handled** — A boolean flag on an event, independent of *Acknowledged*, recording that the
  underlying issue has actually been dealt with. The other half of the triage workflow.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Layer** — Effect's construction-and-wiring primitive (`Layer<ROut, E, RIn>`). This project's
  **dependency-injection mechanism**: services are declared with `Context.Tag` and provided as
  Layers, which `.agents/object-types.md` explicitly exempts from its constructor-DI rule. Test
  doubles are alternative Layers rather than mocks.
  *Canonical:* [ADR `2026-08-03-0035-effect-as-default-idiom`](decisions/2026-08-03-0035-effect-as-default-idiom/adr-body.md).
- **Mapping config** — Per-integration JSON that classifies events: a `rules` record keyed by
  *Trigger*, each yielding an `eventType` + `priority` (+ optional name override), plus a
  **required `default`** so an unmapped trigger is never silently dropped.
  *Canonical:* [AWE-153](../.agents/plans/minimal-event-pipeline/core-layer-contracts.md).
- **Naive client** — A consumer that reads events with nothing more than `aws s3 sync` on a cron
  plus an mtime scan. Deliberately blessed as a first-class consumption path: if the naive client
  works, the contract is simple enough.
  *Canonical:* [`README.md`](../README.md).
- **NormalizedEvent** — The provider-agnostic intermediate a *Transformer* produces: `source`,
  `name`, `timestamp`, *Trigger*, optional work item, and the raw payload. Deliberately carries
  **no** `eventType` and **no** `priority` — classification is a later, separate step.
  *Canonical:* [AWE-153](../.agents/plans/minimal-event-pipeline/core-layer-contracts.md).
- **Notification** — One of the two `eventType` values: an **informational** event that does not
  demand action, as opposed to an *Alert*.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Object-key codec** — The parse/build helpers in the *Event model* that convert between a
  *Canonical event* and its S3 object key,
  `{timestamp}.{type}.{priority}.{source}.{name}.json`. The key leads with an ISO timestamp so
  the bucket sorts chronologically by name alone. Normalizes dotted values in `source`/`name` so
  keys stay unambiguously parseable. **Every producer must build keys through this codec** — a
  second implementation would fork the contract.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/minimal-event-pipeline/event-model-package.md).
- **Origin-verify header** — A secret header CloudFront injects into every request it forwards to
  the webhook ingest origin, which the Lambda checks (in constant time) before doing anything else.
  It exists because CloudFront fronts the HTTP API rather than replacing it, so the raw
  `execute-api` URL stays publicly resolvable; without the check, an attacker could reach the
  origin and bypass the WAF entirely.
  *Canonical:* [AWE-155](../.agents/plans/github-integration/webhook-ingest-infra.md).
- **Priority** — An integer 1–8 carried by every event, orthogonal to `eventType`, used by
  consumers to decide how loudly to surface it.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Product zone** — The Route53 hosted zone for the product itself,
  `personal-events.fifthdimensionengineering.com`: delegated from the parent SLD zone, and in turn
  delegating to each *Environment zone*. It is owned by the *Shared root* and never by an
  environment, because both environments would otherwise contend for the same zone.
  *Canonical:* [AWE-151](../.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md).
- **Push** — Writing an event object **directly into the S3 bucket** from a producer that already
  holds AWS credentials, as distinct from *ingest* (arriving via the webhook endpoint). The
  direct-write path used by the Claude Code hook CLI and by the `event-push` CLI.
  *Canonical:* [`event-push-cli/feature.md`](../.agents/plans/event-push-cli/feature.md).
- **Push recipe** — A documented, copy-paste shell snippet that wires some everyday trigger — a
  crontab line, a git hook, a CI step, a long-job completion — to an `event-push` invocation.
  *Canonical:* [`shell-wrapper-and-recipes.md` (AWE-214)](../.agents/plans/event-push-cli/shell-wrapper-and-recipes.md).
- **Push wrapper** — `bin/event-push`, the bash script that resolves the built push CLI (via
  `EVENT_PUSH_HOME`, else by resolving its own symlinked path) and `exec`s it. **It contains no
  event logic by contract** — no key construction, no validation — which is the structural
  guarantee that the object-key codec has exactly one implementation.
  *Canonical:* [AWE-214](../.agents/plans/minimal-event-pipeline/shell-wrapper-and-recipes.md).
- **Repository** — The layer-5 boundary in front of an external system. Accepts and returns
  *Application Model* values, and owns all knowledge of how to talk to its store. **A third-party
  API is a store like any other** — GitHub sits behind a Repository exactly as S3 does.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Shared root** — The Terraform root module `infra/environments/shared/`, which owns the
  resources that exist **once** across all environments — currently the *Product zone* and its
  delegation from the parent zone. Applied before any environment root.
  *Canonical:* [AWE-151](../.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md).
- **Source** — The identifier of the originating system on an event (`github`, `claude-code`,
  `cron`, …). Appears both in the *Canonical event* body and as a segment of the object key.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Transformer** — The converter sitting at a *Repository* boundary, translating between the
  *Application Model* and a store's *Entity Model* or a third party's payload shape. **The only
  code in the system permitted to know a foreign shape**, which is what keeps provider vocabulary
  from leaking upward.
  *Canonical:* [ADR `2026-08-03-0028-layered-architecture`](decisions/2026-08-03-0028-layered-architecture/adr-body.md).
- **Trigger** — The opaque string key a *NormalizedEvent* carries to select its classification rule
  from a *Mapping config* — e.g. `"pull_request.opened"` or `"Stop"`. Unlike `source` and `name` it
  may contain dots, since it never appears in an object key.
  *Canonical:* [AWE-153](../.agents/plans/minimal-event-pipeline/core-layer-contracts.md).
- **Typed error channel** — The `E` in `Effect<A, E, R>`: failures are values carried in the type
  signature as `Schema.TaggedError` subclasses, so the compiler knows every way a call can fail.
  Errors are never thrown and never collapsed into a `Promise` rejection.
  *Canonical:* [ADR `2026-08-03-0035-effect-as-default-idiom`](decisions/2026-08-03-0035-effect-as-default-idiom/adr-body.md).
- **WebhookIntegration** — The element type of the ingest handler's registry: a `source` plus an
  effectful `handle(rawRequest)`. It is deliberately **not** the pure `Transformer`, because a
  webhook edge additionally needs authentication (HMAC), idempotency (delivery dedupe) and ack-only
  responses. The integration composes the pure transformer *inside* `handle`, which keeps the
  handler a thin router and `@personal-events/core` provider-agnostic.
  *Canonical:* [AWE-155](../.agents/plans/github-integration/webhook-ingest-infra.md).
- **WebhookOutcome** — The result union a *WebhookIntegration* returns — `events`, `ack`,
  `unauthorized`, `bad-request`, `server-error` — which the ingest handler maps to an HTTP status
  through a `Record` lookup. It is the seam that lets the handler stay ignorant of any provider's
  semantics.
  *Canonical:* [AWE-155](../.agents/plans/github-integration/webhook-ingest-infra.md).
- **Work item** — An optional URL on an event pointing at a ticket in an external system, whose
  own workflow and statuses a more sophisticated client may choose to interact with.
  *Canonical:* [`README.md`](../README.md).

## Acronyms & abbreviations

- **ADR (Architecture Decision Record)** — A short document recording an architectural decision
  and its rationale. Required when a new structural element is added, not for routine feature
  work. *Canonical:* [`.agents/guidance/adr.md`](../.agents/guidance/adr.md).
- **AWE** — The ticket prefix for this project's stories in Airtable (e.g. `AWE-213`). Numbers
  are drawn from a **global** counter shared across all projects in the base, so a project's
  ticket numbers are not contiguous.
  *Canonical:* [`.agents/project-tooling/airtable.md`](../.agents/project-tooling/airtable.md).
- **G-C-P (Gather, Compute, Persist)** — The project's core structuring principle: fetch all data
  up front (Gather), run pure functions over it (Compute), then side-effect external systems
  (Persist). *Canonical:* [`.agents/general.md`](../.agents/general.md).
- **IaC (Infrastructure as Code)** — Provisioning infrastructure from version-controlled
  definitions; Terraform here.
  *Canonical:* [`infra-s3-and-dns.md` (AWE-151)](../.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md).
- **PAT (Personal Access Token)** — A GitHub user token. The distinction between **classic** and
  **fine-grained** PATs is load-bearing: the Notifications API accepts only classic PATs, while
  other paths use fine-grained ones.
  *Canonical:* [`github-integration/feature.md`](../.agents/plans/github-integration/feature.md).
- **`EVENT_BUCKET`** — The environment variable naming the target *Event bucket*. Second in the
  bucket-identity precedence order, after the `--bucket` flag. Operators read the value from
  AWE-151's `event_bucket_name` Terraform output; nothing reads Terraform state at runtime.
  *Canonical:* [AWE-213](../.agents/plans/minimal-event-pipeline/s3-repository-and-push-cli.md).
- **`EVENT_PUSH_HOME`** — The environment variable that overrides the *Push wrapper*'s
  repository-root resolution. Takes precedence over symlink self-resolution.
  *Canonical:* [AWE-214](../.agents/plans/minimal-event-pipeline/shell-wrapper-and-recipes.md).
