---
id: bootstrap-and-iac
title: Project Bootstrap & IaC Foundation
type: feature
status: Implementing
parent: none
depends-on: []
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Feature: Project Bootstrap & IaC Foundation

## Definition

### Problem
The repo is a spec with no code, no build, and no cloud substrate. Before any source
(GitHub/Slack/agent) can be ingested, we need the foundational scaffolding: a monorepo that
builds, the canonical event-model contract every component will share, the AWS substrate
(an S3 event bucket and the project's DNS zone), and a first real consumer to prove the loop
end-to-end. Without this, every later feature would re-invent its own tooling, contract, and
deployment story.

### Goals
- A single monorepo that installs, builds, lints, and tests with one command, ready to host
  many packages/apps.
- The event model exists **once** as a shared, versioned package — the load-bearing contract
  (JSON shape + object-key naming scheme) reused by all producers and consumers.
- The AWS foundation is provisioned reproducibly via Terraform: the S3 event bucket and a
  delegated Route53 hosted zone for `personal-events.fifthdimensionengineering.com`.
- An end-to-end proof: a JSON event placed in the bucket surfaces as a native desktop
  notification — validating the bucket + event model with a real client before any ingest
  Lambda exists.

### Solution summary
A pnpm + turbo workspace holds shared tooling config and several workspace members. A
`@personal-events/event-model` package defines the event schema (effect Schema) and the
`{timestamp}.{type}.{priority}.{source}.{name}.json` key codec. A Terraform project under
`infra/` provisions the S3 bucket and a **delegated** Route53 zone (new hosted zone for the
subdomain + NS records in the existing `fifthdimensionengineering.com` parent zone), with
remote state in S3 + a DynamoDB lock table. A `desktop-notifier` daemon app polls the bucket,
parses objects through the event-model package, and raises desktop notifications via
`toasted-notifier` behind a thin typed adapter.

### Out of scope
- The webhook **ingest** Lambda + API Gateway (its own later feature) — here the bucket is
  populated manually to prove the consumer path.
- The SNS/SQS **fan-out queue with TTL** and multi-client subscription model (later feature);
  the desktop client polls the bucket directly for now.
- The Event UI and the Railway-hosted persistent client services (later features).
- Source-specific classifiers (GitHub/Slack/agents).
- CI/CD pipelines beyond the local `turbo` scripts (can follow once the shape is stable).

### Acceptance criteria
- `pnpm install && pnpm build && pnpm lint && pnpm test` all succeed from a clean checkout.
- `@personal-events/event-model` validates a well-formed event, rejects a malformed one with
  a typed error, and round-trips event ⇄ object-key (parse a key back to its components and
  build a key from an event).
- `terraform plan` is clean and `terraform apply` creates the bucket and the delegated zone;
  resolving an NS record for `personal-events.fifthdimensionengineering.com` returns the new
  zone's nameservers. Re-running `plan` shows no drift.
- With the daemon running, writing a valid event object to the bucket produces a native
  desktop notification on macOS within one poll interval; a malformed object is logged and
  skipped without crashing the daemon.
- Failure modes are handled: missing AWS credentials, an unreachable bucket, and an
  unparseable object each produce a clear log line rather than an unhandled crash.
- **Guidance conformance is definition-of-done for every story:** each story ends with a
  dedicated pass reconciling the code against `.agents/general.md` and the TypeScript guidance
  (Gather/Compute/Persist separation, module-level SRP, pure compute + slice-don't-dump, no
  accumulator loops, `Either`/object result types, no enums, `Record` lookups over if/else
  chains) — verified by `biome` + `typecheck`, with `/simplify` available to apply cleanups.

## Plan

### Approach overview
Four stories form a dependency chain that builds the platform bottom-up and ends with a
working vertical slice. The monorepo bootstrap establishes shared tooling so every later
package inherits the same tsconfig/biome/vitest/tsup setup. The event-model package is
authored next because both the infra outputs (bucket naming) and the desktop client depend on
the contract. Infra and the desktop client both build on the bootstrap; the desktop client
additionally needs the event-model (to parse) and the provisioned bucket (to read), so it is
last and serves as the end-to-end proof. Terraform lives under `infra/` as an HCL project
outside the TS build graph, invoked through a thin package script so `turbo` can still see it.

### Story decomposition
Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **monorepo-bootstrap** — pnpm + turbo workspace with shared tooling (root tsconfig base,
   biome, vitest, tsup, Node ≥24, ESM) and a green `install/build/lint/test` on the wired,
   otherwise-empty repo. *(AWE-149)*
2. **event-model-package** — `@personal-events/event-model`: the event schema (effect Schema)
   plus the object-key naming codec with parse/build helpers and tests. *(AWE-150)*
3. **infra-s3-and-dns** — Terraform project: S3 event bucket (versioning + lifecycle), the
   delegated Route53 hosted zone for `personal-events.fifthdimensionengineering.com` with NS
   delegation in the parent zone, and remote state (S3 + DynamoDB lock). *(AWE-151)*
4. **desktop-notifier-daemon** — long-running Node app that polls the bucket, parses events via
   the event-model package, and raises native desktop notifications via `toasted-notifier`
   (thin typed adapter); proves the end-to-end loop. *(AWE-152)*

### Risks
- **Terraform ↔ turbo seam.** HCL sits outside the TS build graph; the `infra` workspace
  member needs a wrapper script and clear conventions so it does not fragment the dev loop.
- **DNS delegation requires real AWS state.** The parent `fifthdimensionengineering.com` zone
  must already exist and be writable by the credentials used; NS delegation propagation is not
  instant, which complicates automated verification.
- **`toasted-notifier` is a single-maintainer CJS fork.** Mitigation: isolate it behind a
  typed adapter module so swapping to a dependency-free `osascript`/`notify-send`/`SnoreToast`
  shell-out later is a one-file change.
- **Remote-state bootstrapping is chicken-and-egg.** The S3 state bucket + DynamoDB lock table
  must exist before `terraform init` can use them; the story must define how that is seeded.
- **Event-model is load-bearing.** Getting the schema and key codec right early avoids churn
  across every later producer/consumer; treat it as a versioned interface from day one.

## Execution status (2026-07-19)

| Ticket | Plan file | Story | Status |
| :--- | :--- | :--- | :--- |
| AWE-149 | `monorepo-bootstrap.md` | Monorepo & tooling bootstrap | **Completed** |
| AWE-150 | `event-model-package.md` | Shared event-model package | **Completed** |
| AWE-151 | `infra-s3-and-dns.md` | IaC: S3 event bucket & Route53 delegated zone | **Implementation Adjustment** — code complete, live verification deferred |
| AWE-152 | `desktop-notifier-daemon.md` | Desktop notifier daemon | **Implementation Adjustment** — code complete, real-bucket E2E deferred |

The feature stays `Implementing` rather than `Completed` because **AWE-151 and AWE-152 are not
terminal**. This work was executed under an explicit **code-and-dry-run fence**: no command that
creates, modifies, or deletes real AWS resources was run, so no bucket was created and **no NS
records were written into the live `fifthdimensionengineering.com` zone.** Each of those two stories
carries a `## Deferred verification` section listing exactly which acceptance criteria remain
unverified and the command that closes each one.

### Feature acceptance criteria

| Criterion | Status |
| :--- | :--- |
| `pnpm install && pnpm build && pnpm lint && pnpm test` succeed from a clean checkout | **Met** (plus `pnpm typecheck`; 119 specs green) |
| The event model validates, rejects with a typed error, and round-trips event ⇄ object key | **Met** (59 specs, exemplar-driven) |
| `terraform plan` is clean | **Met** — `Plan: 8 to add, 0 to change, 0 to destroy`, parent-zone data lookup resolved against the real account |
| `terraform apply` creates the bucket and delegated zone; `dig NS …` resolves; re-`plan` shows no drift | **Unverified** — blocked by the fence, see AWE-151 |
| A valid event object in the bucket produces a macOS notification within one poll interval | **Partially met** — the notification path was proven end to end locally with real macOS notifications from real exemplar bodies, but not against a provisioned bucket; see AWE-152 |
| A malformed object is logged and skipped without crashing the daemon | **Met** (unit-verified against the real poller code path) |
| Missing AWS credentials, an unreachable bucket, and an unparseable object each produce a clear log line rather than a crash | **Met** — all three exercised against the built daemon locally |
| Guidance-conformance pass per story | **Met** — biome (incl. `noEnum`, `noExplicitAny`) + strict tsc clean; the rules no linter can express are recorded in `CLAUDE.md` |

### Cross-cutting decisions taken during execution

- `rewriteRelativeImportExtensions` replaces `allowImportingTsExtensions` so the guidance's
  `./foo.ts` import convention survives tsup's emit. Recorded in `CLAUDE.md`.
- The event model's failure channel is a single tagged `EventModelError` with a discriminating
  `reason`, not a bare string — consumers branch on it, and the daemon does.
- Terraform state locking uses native S3 conditional writes; the DynamoDB lock table in AWE-151's
  original acceptance criteria is **superseded**. ADR `2026-07-19-1900-iac-foundation` records it.
- `.agents/cache/effect/**` does not exist in this repo, so the Effect API was verified against the
  installed typings. **Recommend running `/update-effect-docs`** before the next Effect story.
