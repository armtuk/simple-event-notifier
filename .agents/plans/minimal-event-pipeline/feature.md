---
id: minimal-event-pipeline
title: Minimal event pipeline — bucket, DNS, event model, and push
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: platform-foundation
depends-on: []
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
branch-name: feature/minimal-event-pipeline
---

# Feature: Minimal event pipeline — bucket, DNS, event model, and push

> **Supersedes two earlier features.** This feature absorbs the whole of `bootstrap-and-iac` and
> `event-push-cli`, plus AWE-153 which previously sat inside `github-integration`. Those two
> `feature.md` files were removed on 2026-08-03 and are recoverable from git history. Their stories
> were moved into this directory rather than rewritten from scratch.

## Definition

### Problem

The system has no substrate and no proven write path. There is a spec, a Terraform skeleton
inherited from an unrelated template, and no code at all. Every later capability — a sync client,
desktop notifications, Claude Code hooks, GitHub webhooks — depends on three things existing and
being *demonstrably correct*: a canonical event contract, a bucket to put events in, and a way to
put one there.

Prior planning went wide before it went deep: five features were planned across GitHub, Slack and
Claude Code before a single event had ever been written to S3. That produced dependency knots (the
shared integration template buried inside the GitHub feature, transitively blocking everything
else) and a plan that validated its own load-bearing contract by hand-typing object keys into
`aws s3 cp`.

This feature is the correction: **the absolute minimum that proves the whole idea works
end-to-end**, and nothing else.

### Goals

- **The Application Model exists once** — the canonical `Event` schema and its object-key codec,
  the contract every later producer and consumer couples to.
- **The layer contracts exist** — `Repository`, `Service` and `Transformer` shapes, so the first
  integration has a mould to fill rather than a precedent to invent.
- **The AWS substrate is real and reproducible** — an S3 event bucket and a delegated Route53 zone
  with `development` and `production` subdomains, provisioned by Terraform with no drift on re-plan.
- **The inherited Terraform is reduced to what this feature needs**, with everything else parked
  in a future-state area rather than deleted or left half-wired.
- **An event can be pushed from a shell, from anywhere, in one command** — which makes the contract
  testable by use rather than by inspection.

### Solution summary

Two tracks that converge.

**The TypeScript track** builds a pnpm + turbo workspace, then `@personal-events/event-model` (the
Application Model: effect `Schema` plus the `{timestamp}.{type}.{priority}.{source}.{name}.json`
codec), then `@personal-events/core` (the layer contracts and the mapping-config schema).

**The Terraform track** first quarantines the inherited template — VPC, Lambda, API Gateway,
certificates, ALB logging and the webhook DNS records move to a future-state area, and the existing
`aws_s3_bucket "data_bucket"` is extracted out of `network.tf` into its own `s3.tf` — then
provisions the event bucket and the delegated DNS zones for real.

They converge in `@personal-events/s3-repository`: the Repository over S3, exposing a `bin` so the
same code is both the library every later producer uses and the CLI a human or cron job invokes. A
thin bash wrapper puts it on `$PATH`.

### Out of scope

- **Reading events.** No poller, no consumer, no notifications — that is F2 and F3.
- **Any 3P integration.** No GitHub, no Claude Code, no webhook endpoint, no Lambda.
- **Restoring anything from future-state.** The quarantine is one-way in this feature; F5 brings
  the webhook infrastructure back.
- **npm publication.** The push CLI stays a workspace package plus a local wrapper.
- **Fan-out, SNS/SQS, TTL catch-up, the Event UI.**

### Acceptance criteria

- `pnpm install && pnpm build && pnpm lint && pnpm test` is green from a clean checkout.
- `@personal-events/event-model` validates a well-formed event, rejects a malformed one with a
  typed failure, and **round-trips event ⇄ object-key** — including `source`/`name` values
  containing dots, and boundary priorities 1 and 8.
- `terraform plan` is clean, `terraform apply` creates the bucket and the delegated zone, an `NS`
  lookup for the project subdomain returns the new zone's nameservers, and **re-running `plan`
  shows no drift**. `development` and `production` both resolve.
- `infra/modules/` contains only what this feature provisions; everything else is under the
  future-state area and is **not** referenced by any active module.
- `event-push --type alert --priority 5 --source cron --name backup-failed` writes exactly one
  object whose key matches the codec and whose body validates against the schema — run from an
  arbitrary directory, under bash and zsh, on macOS and Linux.
- The push path is a **Repository**, not a script: the same `putEvent` is what F4 and F5 will call.
- **Failure modes produce clear messages and non-zero exits:** missing/expired AWS credentials,
  unreachable or denied bucket, malformed `--payload` JSON, invalid `--type`/`--priority`, missing
  required flags.
- **Architecture conformance is definition-of-done for every story:** no 3P or foreign shape above
  the Repository boundary (ADR `2026-08-03-0028-layered-architecture`), and Effect for schema,
  structure and async with raw `Promise` only at process entry points
  (ADR `2026-08-03-0035-effect-as-default-idiom`). Verified by `biome`, `typecheck`, `shellcheck`.

## Plan

### Approach overview

The two tracks are genuinely independent and can run in parallel: nothing in the Terraform work
needs the TypeScript to exist, and vice versa. They converge only at AWE-213, which needs both a
built repository package and a real bucket to write into.

```
TS track:   AWE-149 ──▶ AWE-150 ──▶ AWE-153 ─┐
                                             ├─▶ AWE-213 ──▶ AWE-214
IaC track:  AWE-215 ──▶ AWE-151 ─────────────┘
```

The ordering within the TS track is contract-first: the Application Model before the layer
contracts, because the contracts are expressed *in terms of* it. The IaC track quarantines before
provisioning, because `network.tf` currently mixes the event bucket in with the logging bucket, the
Lambda security group and AZ lookups — the bucket cannot be cleanly owned until that file is split.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **monorepo-bootstrap** — pnpm + turbo workspace, shared tooling (tsconfig base, biome, vitest,
   tsup, Node ≥24, ESM), green `install/build/lint/test` on an otherwise-empty repo. *(AWE-149)*
2. **event-model-package** — `@personal-events/event-model`: the **Application Model**. Effect
   `Schema` for the canonical `Event`, the object-key codec, and — required by every downstream
   consumer — exported field schemas `Priority`, `NoDotString`, `IsoInstant`. *(AWE-150)*
3. **core-layer-contracts** — `@personal-events/core`: the `Repository` / `Service` / `Transformer`
   contracts, the mapping-config schema with its required default, and typed error classes.
   Re-scoped from the former integration template. *(AWE-153)*
4. **terraform-future-state-quarantine** — split `network.tf`, `main.tf`, `iam.tf` and `outputs.tf`;
   move VPC, Lambda, API Gateway, cert, ALB logging and webhook DNS to a future-state area; leave a
   plan-clean minimal module. *(AWE-215)*
5. **infra-s3-and-dns** — the S3 event bucket in its own `s3.tf`, the delegated Route53 zone with
   `development` and `production` subdomains, NS delegation in the parent zone, and remote state.
   *(AWE-151)*
6. **s3-repository-and-push-cli** — `@personal-events/s3-repository`: the Repository over S3 plus
   the `bin` that drives it. Absorbs the former standalone S3-writer story. *(AWE-213)*
7. **shell-wrapper-and-recipes** — the shellcheck-clean `bin/event-push` wrapper, `$PATH` install,
   and the documented recipe set. *(AWE-214)*

### Cross-story contracts

- **`event-model` must export its field schemas.** `Priority`, `NoDotString` and `IsoInstant` are
  consumed by AWE-153 and AWE-213. A consumer that re-declares the 1–8 bound or the no-dot rule
  forks the contract; this is called out in AWE-153's plan and is a review gate.
- **Object keys are built only by the codec.** No other package assembles a key string. The bash
  wrapper in AWE-214 contains no event logic whatsoever, which is what structurally prevents a
  second implementation in shell.
- **Bucket identity resolution** (`--bucket` > env var > Terraform output) is decided in AWE-151 and
  consumed by AWE-213; the two must agree.

### Risks

- **The inherited Terraform is a template for a different system.** `network.tf` mixes the event
  bucket with ALB logging and a Lambda security group; `iam.tf` is entirely Lambda/VPC-oriented;
  `dns.tf` only *reads* an existing zone and creates nothing. The quarantine is a split-and-move,
  not a file move, and mis-splitting it silently strands resources.
- **DNS delegation needs real AWS state.** The parent `fifthdimensionengineering.com` zone must
  exist and be writable by the credentials used, and NS propagation is not instant — which
  complicates automated verification of AWE-151's acceptance criteria.
- **Remote-state bootstrapping is chicken-and-egg.** The state bucket and lock table must exist
  before `terraform init` can use them; AWE-151 must define how that is seeded.
- **The event model is a published contract from its first commit.** It is consumed by the bucket's
  whole history and later by an npm-published CLI. Treat it as versioned; changing it after F4/F5
  is a migration, not an edit.
- **Two CLIs with opposite failure contracts.** The push CLI (AWE-213) must exit non-zero so
  automation detects failure; the Claude hook CLI (AWE-162, F4) must exit 0 to protect the agent
  session. Documented in both READMEs.
- **AWE-151 and AWE-153 carry pre-restructure plans.** Both were deep-planned against the old
  feature shape — AWE-153 as a config-driven framework, AWE-151 against greenfield Terraform. Both
  are set to `todo:backlog` and need `/plan-story` re-runs before execution; do not execute their
  existing Plan sections as written.
