---
id: github-integration
title: GitHub Integration & reusable integration template
type: feature
status: Implementing
parent: none
depends-on: [bootstrap-and-iac]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Feature: GitHub Integration & reusable integration template

## Definition

### Problem
GitHub is a primary event source, but the right ingestion mechanism is uncertain and
**permission-dependent**: repository/org **webhooks** are rich and real-time yet require admin
rights to configure, while many setups only have a personal token. We need GitHub activity in
the canonical event model on S3 **either way**, with a **polling fallback** (the Notifications
inbox API, which needs only a user PAT) when webhooks can't be configured. Classification —
which GitHub events are *alerts* vs *notifications* (and at what priority) — must be
**config-driven**, not hardcoded. And because Slack, LLM-agents, and others are coming, this
classification/mapping pattern should be a **reusable template every future integration
plugs into**, not a GitHub one-off.

### Goals
- Ingest GitHub activity into S3 as canonical events via **two paths**: webhooks where the
  user can configure them, and a Notifications-API **poller** as the no-admin fallback.
- A **reusable integration template**: per-integration JSON mapping (event-name/reason →
  `eventType` + `priority`) plus optional **secondary-processing** hooks; GitHub is the first
  concrete instance and adding the next integration is config + a normalizer, not framework
  changes.
- Establish the **generic webhook ingest** (API Gateway + Lambda) that later integrations reuse.
- Be secure and idempotent: HMAC signature verification on webhooks, managed secrets, and no
  duplicate/lost events across polls, restarts, or both paths writing the same bucket.

### Solution summary
An `@personal-events/integration-core` package defines the **template**: a mapping-config
schema (effect Schema), a **pure transform** `(config, rawProviderEvent) → Event`, and adapter
interfaces (`SourceAdapter`, `SecondaryProcessor`). `@personal-events/github` implements the
GitHub instance: effect-Schema validators for the relevant webhook payloads **and** Notification
objects (exemplar-driven), the GitHub **mapping config JSON**, and a normalizer that extracts
the canonical fields from both namespaces. A **generic webhook ingest** — Terraform API Gateway
(HTTP API) + Lambda extending the AWE-151 infra — receives webhooks and dispatches to the
registered integration; the **GitHub webhook handler** verifies `X-Hub-Signature-256` and writes
canonical events to S3. A **scheduled-Lambda poller** (EventBridge `rate(1 minute)`) calls `GET /notifications` with a **classic
PAT** (the Notifications API does **not** support fine-grained PATs or App tokens) using
conditional requests (Last-Modified / `X-Poll-Interval`), maps via the same config, and writes
to S3 — the fallback that needs no admin. Both paths converge on the shared event-model and S3
sink. Webhook signature verification reuses `@octokit/webhooks` (pure ESM, typed payloads).

### Out of scope
- Other integrations (Slack, LLM-agents) — but the template is built to host them.
- **Concrete** secondary processors — only the interface/hook is defined this feature.
- The SNS/SQS fan-out & multi-client subscription queue (separate feature); consumers read S3.
- A GitHub **App** auth model — first pass uses repo/org webhooks + a user PAT for polling;
  GitHub App is noted as a future option, not built here.
- The Event UI.

### Acceptance criteria
- **Permissions matrix documented** (ADR/README): exactly what each path needs — repo
  `admin:repo_hook`/`write:repo_hook` (repo admin) or org-owner for webhooks; a **classic** PAT
  with `notifications` (or `repo`) scope for the Notifications poller (**fine-grained PATs and
  App tokens are unsupported** on `GET /notifications`) — and how to choose between them.
- **Webhook path:** a configured GitHub webhook delivers an event that is HMAC-verified
  (timing-safe), classified via the GitHub mapping config, and written to S3 as a canonical
  event; an invalid signature is rejected (401) and logged; an unmapped event-name falls back
  to a documented default classification rather than being dropped.
- **Polling path:** the scheduled-Lambda poller ingests Notifications-inbox items using a **classic PAT
  only** (no admin), dedupes so no duplicate S3 events occur across polls or restarts, respects
  rate limits via conditional requests (304s don't count), maps via the same config, writes S3.
- **Config-driven:** changing whether an event is an alert/notification or its priority is a
  JSON edit, no code change; the config is schema-validated and rejects unknown shapes.
- **Reusable template:** adding a new integration is a new mapping config + normalizer; the
  `integration-core` framework is untouched.
- **Guidance conformance is definition-of-done for every story** (per `.agents/general.md` +
  TS guidance: G-C-P separation, module SRP, pure transforms + slice-don't-dump, no
  accumulator loops, `Either`/object result types, no enums), verified by biome + typecheck.
- **Failure modes:** invalid signature, malformed payload, GitHub 5xx/429 rate-limit, and a
  missing PAT each produce clear logs and graceful handling — no crash, no data loss, no dupes.

## Plan

### Approach overview
Build the **template first** (pure, reusable, no I/O), then the **GitHub instance** (payload
schemas + mapping config + normalizer), then the **generic ingest infra** (API GW + Lambda),
then the **GitHub webhook handler** on top of it, and finally the **scheduled-Lambda poller** fallback.
The webhook and polling paths share the `integration-core` transform and the GitHub mapping
config and converge on `event-model` → S3, so classification logic exists exactly once. Two
GitHub event namespaces must be reconciled in the mapping config: webhook `X-GitHub-Event`
names (e.g. `pull_request`, `issues`) and Notification `reason` values (e.g. `review_requested`,
`mention`); the config models both.

## Phases

### Phase I — GitHub ingestion and the reusable template · Implementing · (opened 2026-06-28)

| Ticket | Plan file | Story | Status |
| :--- | :--- | :--- | :--- |
| AWE-153 | `integration-framework.md` | Reusable integration template (`integration-core`) | **Completed** |
| AWE-154 | `github-event-mapping.md` | GitHub payload schemas, mapping config & normalizer | **Implementation Adjustment** |
| AWE-155 | `webhook-ingest-infra.md` | Generic webhook ingest (API Gateway + Lambda) | **Implementation Adjustment** |
| AWE-156 | `github-webhook-handler.md` | GitHub webhook handler (signature verify → S3) | **Implementation Adjustment** |
| AWE-157 | `github-notifications-poller.md` | GitHub activity poller (scheduled-Lambda fallback) | **Implementation Adjustment** |

The four non-terminal stories are non-terminal **by design**, not because work is outstanding: each
has acceptance criteria that can only be closed by `terraform apply`, a real webhook registration, a
real PAT, or a Lambda/EventBridge deployment — all outside the execution fence. Every such criterion is
enumerated in that story's `## Deferred verification` table with the exact command that closes it.
The feature reaches `Completed` when those are run, not when more code is written.

### Story decomposition
Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **integration-framework** — `@personal-events/integration-core`: mapping-config schema,
   pure `transform(config, rawEvent) → Event`, and `SourceAdapter`/`SecondaryProcessor`
   interfaces + config loader. The reusable template. *(AWE-153)*
2. **github-event-mapping** — `@personal-events/github`: effect-Schema validators for the
   relevant webhook payloads + Notification objects (exemplar-driven), the GitHub mapping
   config JSON (event-name & reason → eventType + priority), and the normalizer. *(AWE-154)*
3. **webhook-ingest-infra** — generic API Gateway (HTTP API) + Lambda ingest in Terraform
   (extends AWE-151) with a custom domain under `personal-events.fifthdimensionengineering.com`,
   plus the generic Lambda handler skeleton that dispatches to a registered integration and
   writes to S3. *(AWE-155)*
4. **github-webhook-handler** — the GitHub webhook path wired into the ingest: HMAC
   `X-Hub-Signature-256` verification, `X-GitHub-Event` parsing, `X-GitHub-Delivery` dedupe,
   secret management, map → S3. *(AWE-156)*
5. **github-notifications-poller** — the EventBridge-scheduled Lambda that **dual-polls** the
   Notifications API (classic PAT) **and** the Events API (any token, richer payloads), with
   per-source conditional requests, cursors/dedupe, and rate-limit handling, map → S3 — the
   no-admin fallback. *(AWE-157)*

### Risks
- **Permission uncertainty (the core worry):** mitigated by the dual paths — the poller works
  with just a PAT, so the system functions even with zero webhook-admin rights.
- **Divergent event namespaces:** webhook `X-GitHub-Event`+`action` vs Notification `reason`
  values do not match (e.g. `pull_request.review_requested` ≠ `review_requested`); the mapping
  config models triggers as a **`source`-discriminated union** so the paths can't be confused.
- **No webhook auto-retry:** GitHub does **not** automatically retry failed deliveries (only
  manual redelivery for ≤3 days), and requires a 2xx within ~10s. So the handler must respond
  fast and the poller acts as the practical backstop if a webhook delivery is lost — design for
  that rather than assuming retry-on-5xx.
- **Two distinct credentials for full coverage:** the Notifications API needs a **classic** PAT,
  while webhook registration / the (optional) Events API path use a **fine-grained** PAT — the
  secrets layer must hold both credential types if both are enabled.
- **Dual-source fallback (decided):** the poller polls **both** the Notifications API and the
  Events API (`GET /users/{u}/received_events`) — folded into AWE-157. Events adds rich
  actor+action payloads the inbox lacks, at the cost of 30s–6h latency, 30-day/300-event
  retention, and a second credential; dedupe per source guards the overlap.
- **Idempotency across paths:** webhook (`X-GitHub-Delivery`) and poller (notification id +
  `updated_at`) both write the same bucket; dedupe keys + the event-key scheme must prevent
  duplicates, especially if both paths are enabled for the same repo.
- **Secret management:** the webhook HMAC secret (AWS SSM/Secrets Manager) and the poller PAT
  (SSM SecureStrings) need secure storage; the poller Lambda uses its IAM role to write S3.
- **Public endpoint security:** the webhook URL is internet-facing — signature verification is
  the gate; also consider payload-size limits and replay.
- **Rate limits:** unconditional polling burns the 5000/hr core budget; conditional requests
  (ETag/Last-Modified → 304) and honoring `X-Poll-Interval` are required.
- **New architecture element:** write an **ADR** for the integration template + dual-path design.
- **Depends on `bootstrap-and-iac`:** needs the monorepo (AWE-149), `event-model` (AWE-150),
  and the S3 bucket + Terraform infra (AWE-151) to exist first.

## Follow-up candidates — recorded for the user, deliberately not implemented

### 1. The ordering hazard is the *norm* for both poller channels, not a coincidence

Level 0's review found, and deliberately did not fix, that a consumer's S3 high-water mark is over
**producer-supplied** timestamps: an object whose key sorts below the current mark is never re-listed
and is permanently undelivered (`packages/event-model/README.md` § "Key order is not write order";
`apps/desktop-notifier/src/poller.ts`; `.agents/plans/bootstrap-and-iac/feature.md` § Follow-up
candidates).

**This feature makes that hazard routine rather than rare, on both poller channels.** AWE-154's
resolved decision sets a notification event's `timestamp` from the Notifications API's `updated_at`,
and AWE-157's sets an activity event's from the Events API's `created_at`. **GitHub emits both at
second precision** — the package's own exemplars show it (`notification-mention.json`
`2026-07-19T19:02:11Z`, `events-api-push.json` `2026-07-19T19:14:52Z`). Normalised into the contract's mandatory three-digit fraction each becomes
`.000`, so **every item in a batch that shares a second shares a millisecond** — and a batch is
exactly what one poll returns. Only the webhook path is exempt, because its `receivedAt` is an
injected `new Date().toISOString()`.

> **Corrected by R1-3.** Until the R1 review round this feature claimed in three places that the
> Events API channel was immune. It is not; its exemplars disprove it. The claim is fixed in
> `packages/github/src/normalizer.ts`, in AWE-157's design decisions, and in the spec name that
> encoded it, and the channel is now inside this follow-up's scope. A consumer poll landing mid-batch advances its mark past siblings
it has not seen, and loses them permanently.

What was done here: the behaviour is documented at its source (`packages/github/src/instant.ts`),
pinned by characterization specs in `instant.spec.ts` and `normalizer.spec.ts`, and recorded in the
feature ADR. **No sub-second detail is invented** — `.000` is honest about the precision that
arrived.

**The *overwrite* half of this hazard is now fixed** (see #3): the key carries `eventId`, so
same-second siblings no longer collide. What remains is the *ordering skip* — a consumer's bare
high-water mark can still advance past a sibling it has not yet delivered, because the two keys sort
adjacently.

> **Decided remedy (2026-07-21), deferred to its own story.** The earlier open question —
> at-most-once vs retry-until-delivered vs quarantine, and how wide a lookback — is **resolved** in
> favour of **retry-with-lookback**: a consumer sets `StartAfter = max(mark − lookbackWindow, seed)`
> and keeps a bounded **delivered-key set** in its state to suppress the re-reads the overlap
> produces. This is a **consumer-side** change (`apps/desktop-notifier` and any future reader), not a
> producer change, so it is not built in this feature. It is the same fix that closes
> `bootstrap-and-iac` #12 and R2-1. A new story under this feature (or a `desktop-notifier` story)
> owns it.

### 2. No specificity ladder in the mapping match (surfaced by AWE-154)

`integration-core` matches a trigger by an **exact** match-key over all its fields. A rule is
therefore matched only by a trigger with precisely the same field set, which has two consequences an
operator will eventually hit:

- `{ "channel": "webhook", "event": "pull_request" }` does **not** catch every `pull_request` action,
  because a real delivery's trigger always carries an action.
- Any field the normalizer always emits but rules rarely constrain must be left out of the trigger
  entirely. This is why GitHub notification triggers carry only `reason` and not `subject.type`
  (AWE-154 § Design decisions) — the first implementation included it and every notification rule
  silently fell through to the default.

The general fix is a **specificity ladder**: the provider declares an ordered list of candidate
triggers (most specific first) and `classify` takes the first hit. It is a framework change touching
every integration's contract, so it is recorded here rather than taken mid-feature. Until then the
mitigations are in place: GitHub rejects an unproducible trigger shape at config load
(`mapping-validation.ts`) instead of accepting a rule that could never fire, and the constraint is
documented in both package READMEs.

### 3. Two distinct events sharing one object key — FIXED (2026-07-21) by the contract change

**Found by the R1 review, reproduced, and — on the user's explicit approval — fixed properly in the
event-model contract rather than merely recorded.**

The old key `{timestamp}.{type}.p{priority}.{source}.{name}.json` carried **no per-item identity**.
Given #1 (both poller channels second-precision) and classification keyed on the notification
`reason` alone, two distinct same-second same-reason notifications built a byte-identical key and the
second `PutObject` silently overwrote the first — `count: 2`, both succeed, cursor advances, one event
gone with no error. Reproduced directly against the built packages before the fix
(`…alert.p4.github.mention.json` for two different mentions).

**The fix:** `@personal-events/event-model` now carries `producer` and `eventId` in the body and the
key (`…{name}.{producer}.{eventId}.json`). `eventId` is the provider's own delivery/event id (a
notification id here), so two distinct items get distinct keys and a re-delivery rebuilds the *same*
key — idempotent. The poller's characterization specs flipped from "one object survives" to "two
distinct objects survive"; `event-model`'s README now truthfully says "one object key denotes one
event". Level 0's `event-model`/`desktop-notifier` were updated in step and stay green. See the ADR
§ "The overwrite collision — solved".

This closed the *overwrite* defect. The distinct-but-adjacent *ordering* skip is #1's remaining
half, with its own decided lookback remedy.

### 4. Three near-duplicate S3-client, config and logging modules across the app edges

`packages/event-sink/src/s3-client.ts` carries a bucket probe near-identical to
`apps/desktop-notifier/src/s3-client.ts` (Level 0). Collapsing them was deliberately **not** done
mid-feature because it would move a Level 0 app's specs while this feature was in flight — but the
pointer in `event-sink`'s docblock claimed a follow-up existed here when none did (R1-12), so this is
that entry.

The same accretion shows up in the edges more broadly: `deploymentEnvs` / `logLevels` /
`omitUndefined` are now declared in **three** app config modules, the winston factory in three, and
`capturingLogger` in three testing modules. The environment vocabulary is the sharpest of these — it
is a `CLAUDE.md` carve-out that exists precisely to stop the five values drifting, and it is now
written out three times.

One "collapse the app edges onto shared modules" change covers all of it: a small shared
runtime/config package holding the environment vocabulary, the log levels, the winston factory and
the bucket probe, with `desktop-notifier`, `webhook-ingest` and `github-poller` all consuming it.
Deferred rather than done here because it touches a Level 0 app.
