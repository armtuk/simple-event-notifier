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
- The Event UI and the AWS-hosted ingest services — scheduled-poll Lambdas, and the S3 + CloudFront
  Event UI (later features; the platform is AWS-only, no Railway).
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
| `pnpm install && pnpm build && pnpm lint && pnpm test` succeed from a clean checkout | **Met** (plus `pnpm typecheck`, all four verified uncached with `--force`; 182 specs passing and 5 skipped opt-in specs as measured at the R3 gate — 87 event-model + 95 desktop-notifier) |
| The event model validates, rejects with a typed error, and round-trips event ⇄ object key | **Met** (87 specs, exemplar-driven; the round trip is now pinned as *injective* — every key the codec accepts re-encodes to itself) |
| `terraform plan` is clean | **Met** — `Plan: 8 to add, 0 to change, 0 to destroy`, parent-zone data lookup resolved against the real account; re-confirmed after the shared-module refactor |
| `terraform apply` creates the bucket and delegated zone; `dig NS …` resolves; re-`plan` shows no drift | **Unverified** — blocked by the fence, see AWE-151 |
| A valid event object in the bucket produces a macOS notification within one poll interval | **Partially met** — the notification path was proven end to end locally with real macOS notifications from real exemplar bodies, but not against a provisioned bucket; see AWE-152 |
| A malformed object is logged and skipped without crashing the daemon | **Met** — the skip is unit-verified against the real poller code path, and the **log line itself** is now asserted (level `warn`, the offending `key`, and a `reason` naming the field) via a capturing winston transport. Before the R1 review this row was marked Met with no log assertion anywhere; that was an overclaim. |
| Missing AWS credentials, an unreachable bucket, and an unparseable object each produce a clear log line rather than a crash | **Met** — credentials and bucket failures exercised against the **built daemon**; the unparseable-object path against the real poller code path in the unit suite. (Corrected: this row previously said "all three exercised against the built daemon", which was true of only two.) |
| Guidance-conformance pass per story | **Met** — biome (incl. `noEnum`, `noExplicitAny`) + strict tsc clean; the rules no linter can express, and the two deliberate carve-outs from them, are recorded in `CLAUDE.md` |

### Cross-cutting decisions taken during execution

- `rewriteRelativeImportExtensions` replaces `allowImportingTsExtensions` so the guidance's
  `./foo.ts` import convention survives tsup's emit. Recorded in `CLAUDE.md`.
- The event model's failure channel is a single tagged `EventModelError` with a discriminating
  `reason`, not a bare string — consumers branch on it, and the daemon does.
- Terraform state locking uses native S3 conditional writes; the DynamoDB lock table in AWE-151's
  original acceptance criteria is **superseded**. ADR `2026-07-19-1900-iac-foundation` records it.
- `.agents/cache/effect/**` does not exist in this repo, so the Effect API was verified against the
  installed typings. **Recommend running `/update-effect-docs`** before the next Effect story.


## R1 code review — 2026-07-19

An independent R1 pass (`claude-automated-code-review.md`) returned **1 blocker, 6 major, 8 minor,
3 nits**. The blocker and all six majors are fixed, as are minors #8, #9, #10, #13, #14, #16 and
nits #17, #18, #19, #20. Per-story detail is in each story's `## R1 review fixes` section.

The blocker is worth restating here because it was a **silent data-loss bug in the load-bearing
contract**: `isoInstantPattern` allowed a variable-width millisecond fraction, and since `.` sorts
below every digit while `Z` sorts above every digit, object keys did **not** sort chronologically.
A consumer's `StartAfter` high-water mark would jump past earlier events and never return them. The
two committed exemplars already used different precisions, so this was live. Timestamps are now
fixed at exactly three fractional digits, with specs asserting lexicographic order equals
chronological order.

Four findings were **deliberately not implemented** and are recorded below instead.

## Follow-up candidates

Recorded rather than fixed on this branch — captured so they are future work, not silent drops.

| # | Item | Why it is deferred |
| :-- | :--- | :--- |
| R2-1 | **The high-water mark is over producer-supplied timestamps, so an object written with a key that sorts below the current mark is never delivered.** Two live routes, same permanence as the R1 blocker: (a) **same-instant tie-break** — within one millisecond keys order by `eventType` → `priority` → `source` → `name`, and `alert` < `notification`, so a producer stamping one batch with a single `toISOString()` and PutObject-ing sequentially can write B then A; a poll landing between the two advances the mark past A forever. This is **not a coincidence a reader should triage as unlikely**: it is the norm for the first planned producer, because AWE-154's resolved mapping decision sets `timestamp = updated_at` from the GitHub Notifications API (`github-event-mapping.md:75,211`), whose values are second-granular and carry no fractional part — normalised into the contract's mandatory `.000`, every notification in a batch that shares a second shares a millisecond, and the loss then needs only a poll landing mid-batch. (b) **producer clock skew** — a slow-clocked machine writes below a mark a fast one already set. | **Needs the same product decision as #12** and should be asked in the same breath. The fix is a lookback poll (`StartAfter = max(mark − lookbackWindow, seed)`) plus a delivered-key set in `state.json` so a late or skewed write inside the window is still delivered exactly once; the window size *is* the maximum producer skew the system tolerates, which is the owner's call. Deliberately not implemented on this branch. `poller.ts`'s docblock now states the limitation accurately (it previously asserted the opposite), and `poller.spec.ts` carries a characterization test pinning both routes so the follow-up fix has to turn them green consciously. |
| #11 | The schema accepts values that cannot survive the key contract: `isoInstantPattern` is shape-only, so impossible instants (`2026-13-45T99:99:99.000Z`) pass and will `NaN` in any consumer doing `new Date(...)`; and `noDotPattern` forbids only `.`, so `source`/`name` may contain `/` (silently turning the key into a prefix), spaces, or control characters. | Both are real tightenings, but they narrow an already-published contract's accepted set. Now that #1 pins the fraction to three digits, `new Date(s).toISOString() === s` is an exact round-trip check and costs nothing — worth doing as a deliberate change with its own exemplars, not folded into a review-fix round. |
| #12 | **Needs a product decision, not an engineering one.** A valid event whose *notification* fails is skipped permanently, because the mark advances over every listed key. Combined with `fallbackNotifier`'s latch, a machine where no notifier works (headless session, missing `notify-send`, TCC-denied `osascript`) logs an error per event and drops all of them, unreplayable. There is also no DLQ/quarantine anywhere, which `.agents/tests.md` names as a thing to assert on. | The bucket is the permanent source of record, so nothing is *lost* — but a consumer silently deciding an event was never seen is a semantics choice the owner should make: at-most-once (today) vs. retry-until-delivered vs. quarantine-and-continue. **Ask the user which they want** before implementing. Advancing past *unparseable* objects is separate and is correct as-is — the alternative is a poison pill that stalls every later event. |
| #15 | One tick fans out an unbounded `Promise.all` over every new key. In steady state that is a handful; after a week asleep, or on the first run of the `--backfill` flag the plan anticipates, it is one concurrent `GetObject` per object in the window — enough to hit SDK socket limits and turn a recoverable catch-up into a whole-tick failure. | Needs a `maxObjectsPerTick` in `DaemonSchedule` and a chunked fetch. It is a real robustness gap but only bites on a large catch-up window, which cannot happen until the bucket exists and has history. Natural companion to the `--backfill` story. |
| #20 | Dotted S3 bucket names force path-style addressing and rule out a same-name CloudFront origin later. | Not a defect — it follows `.agents/guidance/aws.md`'s naming convention exactly. Recorded as an accepted trade-off in ADR `2026-07-19-1900-iac-foundation`; revisit only if the bucket must front a CloudFront distribution. |

## R2 code review — 2026-07-19

A second independent pass (`claude-automated-code-review.md` → `## R2 — 2026-07-19`) returned
**0 blockers, 1 major, 7 minor, 4 nits**, and its fix audit confirmed every R1 fix genuinely resolves
its defect — *"nothing was found to be superficially patched but still broken."*

All twelve findings are dispositioned. Two are worth surfacing at feature altitude:

- **R2-1 (major)** is the part of the R1 blocker's invariant that pinning the timestamp width did not
  close: key order equals *chronological* order for distinct instants, but never equalled *write*
  order. Recorded above as a follow-up candidate, and `poller.ts` no longer claims otherwise. The
  fix is deliberately deferred because it carries the same product decision as #12.
- **R2-2 (minor)** was the R1 #7 dedup silently re-enabling contract drift one layer down:
  `turbo.json`'s explicit `inputs` array omitted `exemplars/**`, so editing a canonical exemplar
  invalidated no hash and the consumer's suite replayed a cached **PASS**. Reproduced, fixed, and the
  fix verified by drifting an exemplar and confirming the consumer suite genuinely re-runs and fails.

**R2-4 disputed in part; the dispute was upheld in R3, with one correction.** Async stack depth is not
a discriminator for the daemon-loop regression guard — it does not grow across the recursive `await`
(5 frames vs 3) — and the async frames themselves are not retained, because the recursive call is in
tail position. But heap retention *does* diverge: R3 measured the chained shape leaking ~97 bytes/tick
(the chain of pending promise objects), linear and unbounded — ~280 KB/day at the 30 s default. So the
bug is real and the fix is right; it is ~30× cheaper per tick than R1 framed it, and it is not free.
It is still not cheaply testable (the signal needs `--expose-gc` and ~10⁵ ticks), so R2's alternative
was taken — the spec is renamed to what it actually tests and the non-chaining shape is recorded in
`CLAUDE.md` as a review responsibility, now with the measured numbers as its justification.

**R2-6 supersedes the earlier `local`-only carve-out.** The project now has one environment
vocabulary — `local`, `dev`, `qa`, `staging`, `prod` — applied verbatim in Terraform and TypeScript
and stated once in `CLAUDE.md`. Both halves point back at it.

**Awaiting a user ruling:** the environment-vocabulary deviation from `logging.md` (flagged by the
coordinator), and the delivery-semantics question shared by #12 and R2-1.