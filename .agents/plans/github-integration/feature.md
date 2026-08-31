---
id: github-integration
title: GitHub integration — webhook ingest for armtuk repositories
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: event-sources
depends-on: [minimal-event-pipeline]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-31
branch-name: feature/github-integration
---

# Feature: GitHub integration — webhook ingest for armtuk repositories

> **Restructured 2026-08-03.** Three changes from the original shape. **AWE-153** (the reusable
> integration template) moved to `minimal-event-pipeline`, where it belongs — it was never
> GitHub-specific and its presence here transitively blocked every other integration.
> **AWE-157** (the Notifications/Events poller) was abandoned: the dual-path design existed to cover
> the case where the user lacks webhook-admin rights, which does not apply to repositories the user
> owns. The feature is consequently **single-path**, and the `channel`-discriminated trigger that
> existed to reconcile GitHub's two API namespaces is no longer needed.

## Definition

### Problem

GitHub is the primary third-party event source: pull requests, reviews, issues and CI outcomes are
exactly the "needs my attention" signals the system exists to surface. The repositories in question
are owned by the `armtuk` user, so **repository webhooks are configurable** — the permission
uncertainty that drove the original dual-path design does not apply.

What remains genuinely hard is the public surface. A webhook endpoint is internet-facing and
unauthenticated by default; it must verify HMAC signatures in constant time, respond within
GitHub's ~10-second budget, and tolerate the fact that **GitHub does not automatically retry failed
deliveries** — only manual redelivery within three days.

### Goals

- Ingest GitHub activity for `armtuk` repositories into S3 as canonical events, in real time.
- Restore and complete the **webhook ingest infrastructure** parked in future-state during F1.
- **Config-driven classification** — which GitHub events are alerts and at what priority is a JSON
  edit, not a code change.
- **Secure and idempotent:** HMAC verification, managed secrets, and no duplicate events across
  redeliveries.
- Prove the layering **generalizes to a second, differently-shaped source** — inbound HTTP rather
  than a local process.

### Solution summary

The second functional area, mirroring F4's shape but entering through a deployed controller:

- **3P model + Transformer** (`@personal-events/github`) — effect `Schema` validators for the
  consumed webhook payloads (exemplar-driven, `@octokit/openapi-webhooks-types`) plus the
  transformer to canonical `Event`. The only code that knows GitHub's wire shape.
- **Service** — classification via the GitHub mapping config over `@personal-events/core`.
- **Repository** — F1's `s3-repository` for the write; a small dedupe repository over S3 markers
  for `X-GitHub-Delivery` idempotency; a secret repository over SSM.
- **Controller** — an API Gateway (HTTP API) + Lambda handler, restored from future-state, verifying
  `X-Hub-Signature-256` and returning fast.

### Out of scope

- **The Notifications/Events poller** — abandoned with AWE-157. If webhook admin is ever
  unavailable for some repository, that is a new feature, not a revival.
- **A GitHub App auth model.** Repository webhooks plus a secret are sufficient for `armtuk` repos.
- **Concrete secondary processors** — the layering's Service seam is where they would go, later.
- Other integrations; the Event UI; SNS/SQS fan-out.

### Acceptance criteria

- **Setup is documented:** exactly which repository settings and permissions are needed
  (`admin:repo_hook` on each `armtuk` repo), the endpoint URL, the secret, and the content type.
- **Webhook path:** a real delivery is HMAC-verified (timing-safe), classified via the mapping
  config, and written to S3 as a canonical event. An invalid signature is rejected `401` and logged.
  An unmapped event falls back to a documented default rather than being dropped.
- **Idempotent:** the same `X-GitHub-Delivery` — including a manual redelivery — does not produce a
  duplicate S3 event.
- **Fast enough:** the handler responds within GitHub's delivery budget; slow work does not run
  inline with the response.
- **Infrastructure is restored cleanly:** the future-state Terraform is brought back and wired, and
  `terraform plan` is clean with no drift on re-run.
- **Failure modes** each log clearly and behave gracefully — no crash, no data loss, no duplicates:
  invalid signature, malformed payload, unknown event type, S3 write failure (→ 5xx so redelivery is
  possible), missing secret.
- **Architecture conformance:** no GitHub shape above the transformer; the handler contains no
  classification; Effect throughout with `Promise` only at the Lambda `handler` export.

## Plan

### Approach overview

Schemas and transformer first — pure, exemplar-driven, testable with no infrastructure. Then the
generic ingest infrastructure, restored from the future-state area F1 parked it in. Then the GitHub
controller on top of it.

Because there is now **one channel**, the mapping config keys directly off `X-GitHub-Event` plus
`action`, with no discriminated-union machinery to keep two namespaces apart.

Since GitHub does not auto-retry, the S3 write must complete before a 2xx is returned, and any
failure must surface as a 5xx so manual redelivery remains possible. That is the opposite of the
fire-and-forget stance F4 takes, and it is deliberate.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **github-event-mapping** — `@personal-events/github`: webhook payload schemas (exemplar-driven),
   the transformer to canonical `Event`, the mapping config, and the classification service.
   *(AWE-154)*
2. **webhook-ingest-infra** — restore the API Gateway (HTTP API) + Lambda + certificate Terraform
   from future-state, wire the custom domain under the project zone from AWE-151, and the generic
   handler skeleton that dispatches to a registered integration. *(AWE-155)*
3. **github-webhook-handler** — the GitHub controller: `X-Hub-Signature-256` verification,
   `X-GitHub-Event` parsing, `X-GitHub-Delivery` dedupe, secret management via SSM, write through
   `s3-repository`. *(AWE-156)*

### Cross-story contracts

- **The webhook secret** is provisioned in AWE-155's Terraform (SSM parameter) and consumed by
  AWE-156's secret repository; the parameter name is the contract.
- **Classification lives in AWE-154**, never in the handler.
- **The dedupe marker prefix** in the event bucket is defined in AWE-156 and must not collide with
  the event key space — F1's codec owns the event namespace.

### Risks

- **Public endpoint security.** The URL is internet-facing; signature verification is the only gate.
  Payload-size limits, replay tolerance and a rate limit need explicit decisions — per
  `.agents/guidance/deployment-environments/aws.md`, an exposed endpoint carries a WAF with at least
  default IP filtering and a realistic rate-limit rule.
- **No auto-retry from GitHub.** A dropped delivery is gone unless manually redelivered within three
  days. With the poller abandoned there is **no backstop** — this is a deliberate, recorded
  reduction in resilience, and it makes the handler's error handling load-bearing.
- **Restoring future-state Terraform is not a straight revert.** It was parked as a template for a
  different system (ALB logging, VPC, Lambda-in-VPC assumptions). AWE-155 must restore only what is
  needed and re-verify it against `aws.md` rather than re-enabling the whole module.
- **Lambda-in-VPC versus S3 access.** `aws.md` requires Lambdas on a VPC, which then needs a NAT
  gateway or an S3 VPC endpoint for bucket writes — a real cost and complexity decision that the
  inherited `vpc.tf` assumed silently.
- **Secret management.** The HMAC secret needs secure storage and rotation; AWE-155 provisions it,
  AWE-156 reads it, and neither should ever log it.
- ~~**AWE-155 and AWE-156 carry pre-restructure plans.**~~ **Partly resolved 2026-08-31.**
  **AWE-155 — Generic webhook ingest (API Gateway + Lambda)** has been re-planned and is `ready`.
  **AWE-156 — GitHub webhook handler (signature verify → S3)** is **still** `todo:backlog` and
  still carries its pre-restructure plan: it names `integration-core`, specifies winston, and was
  written against the dual-path shape. It needs a `/plan-story` re-run before execution.
- **The endpoint is an API Gateway REST API with a natively-attached WAF** (decided 2026-08-31).
  AWS WAF cannot attach to an HTTP API, and the inherited `apiGateway.tf` is **already** a REST
  API — so reusing it attaches WAF directly to the stage, with no CloudFront hop and no
  origin-verify mechanism. A CloudFront-fronted HTTP API was considered and rejected the same day.
  WAF still adds roughly **$10/month per environment**, the largest recurring cost in the system.
  The ingest Lambda is deliberately **not** VPC-attached — a recorded deviation from `aws.md`,
  justified by its having no private-network dependency.
