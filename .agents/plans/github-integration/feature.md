---
id: github-integration
title: GitHub Integration & reusable integration template
type: feature
status: In Planning
parent: none
depends-on: [bootstrap-and-iac]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-06-28
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
canonical events to S3. A **persistent Railway poller** calls `GET /notifications` with a **classic
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
- **Polling path:** the Railway poller ingests Notifications-inbox items using a **classic PAT
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
then the **GitHub webhook handler** on top of it, and finally the **Railway poller** fallback.
The webhook and polling paths share the `integration-core` transform and the GitHub mapping
config and converge on `event-model` → S3, so classification logic exists exactly once. Two
GitHub event namespaces must be reconciled in the mapping config: webhook `X-GitHub-Event`
names (e.g. `pull_request`, `issues`) and Notification `reason` values (e.g. `review_requested`,
`mention`); the config models both.

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
5. **github-notifications-poller** — the Railway persistent service that **dual-polls** the
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
  (Railway env/secret) need secure storage; the Railway poller also needs AWS creds to write S3.
- **Public endpoint security:** the webhook URL is internet-facing — signature verification is
  the gate; also consider payload-size limits and replay.
- **Rate limits:** unconditional polling burns the 5000/hr core budget; conditional requests
  (ETag/Last-Modified → 304) and honoring `X-Poll-Interval` are required.
- **New architecture element:** write an **ADR** for the integration template + dual-path design.
- **Depends on `bootstrap-and-iac`:** needs the monorepo (AWE-149), `event-model` (AWE-150),
  and the S3 bucket + Terraform infra (AWE-151) to exist first.
