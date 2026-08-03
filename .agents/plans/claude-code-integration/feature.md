---
id: claude-code-integration
title: Claude Code integration — hook events to S3 via a local CLI
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: event-sources
depends-on: [minimal-event-pipeline]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-08-03
branch-name: feature/claude-code-integration
---

# Feature: Claude Code integration — hook events to S3 via a local CLI

> **Restructured 2026-08-03.** `depends-on` was `[github-integration]`, which over-serialized this
> feature behind GitHub's entire webhook stack for the sake of one shared package. That package
> (AWE-153) now lives in `minimal-event-pipeline`, so the real edge is recorded here and this
> feature can run as soon as F1 lands. AWE-160 — Shared S3 event writer was abandoned; its scope is
> absorbed by AWE-213 in F1.

## Definition

### Problem

LLM agent sessions are a first-class event source from the README — *"when prompts complete"* and
*"when the LLM has a question."* Claude Code emits exactly those moments as hooks (`Stop`,
`Notification`, `SubagentStop`, `SessionStart`/`SessionEnd`) with a JSON payload on stdin.

The constraint that shapes everything: a hook runs **on every machine the user runs Claude Code
on** — desktop, laptop, servers — not in one deployed service. So ingestion must be trivially
installable anywhere, and it must never add latency to, or break, an interactive agent turn.

### Goals

- Ingest Claude Code session moments into S3 as canonical events, classified config-driven.
- **Direct, infra-free path** — the hook writes straight to S3 with the machine's ambient AWS
  credentials. No webhook, no API Gateway, no Lambda.
- **Installable anywhere** — published to npm under `@alexrmturner` so any machine wires it up with
  `npx` or a global install, with no monorepo checkout.
- **Never harms the session** — the hook returns effectively instantly, and any failure logs and
  exits 0.

### Solution summary

This is the **first concrete functional area** built on the layering in ADR
`2026-08-03-0028-layered-architecture`, and it should read as a template for F5:

- **3P model + Transformer** (`@personal-events/claude-code`) — effect `Schema` validators for the
  hook envelope and consumed hook events, exemplar-driven from real payloads, plus the transformer
  that converts a hook payload into a canonical `Event`. **This is the only code that knows
  Claude Code's wire shape.**
- **Service** — classification: the `source: "claude-code"` mapping config (`hook_event_name`/state
  → `eventType` + `priority`, most-specific-first with a documented default) applied over the
  transformed event, using the mapping-config schema from `@personal-events/core`.
- **Repository** — none of its own. It writes through F1's `@personal-events/s3-repository`.
- **Controller** — `@alexrmturner/claude-events`, the CLI the hook invokes: reads hook JSON from
  stdin, delegates, and owns the exit-code contract.

### Out of scope

- **The webhook ingest path** for Claude events — direct write is used instead. The transformer is
  transport-agnostic, so an HTTP transport could be added later without touching classification.
- **A local spool / background flusher daemon** and offline buffering.
- Hooks beyond the session-signal set (`PreToolUse`/`PostToolUse`/`UserPromptSubmit` firehose).
- The Event UI; SNS/SQS fan-out.

### Acceptance criteria

- With the CLI installed and `settings.json` hooks wired, completing a turn (`Stop`) and Claude
  pausing for the user (`Notification`) each produce a canonical event in S3 with
  `source: "claude-code"` and a codec-conformant key.
- **No turn latency, no session breakage:** the hook returns effectively instantly, and a failure to
  reach S3 produces a clear stderr log and **exit 0** — never blocking or crashing the session.
- **Config-driven classification:** alert-vs-notification and priority are a JSON edit; an unmapped
  hook event hits a documented default rather than being dropped.
- **Installable anywhere:** `npx @alexrmturner/claude-events` works on a machine with no checkout;
  the published bundle is self-contained.
- **Idempotent:** the same hook delivery does not double-write across retries or replays.
- **Failure modes** each log clearly and exit 0: missing AWS credentials, unreachable/denied bucket,
  malformed or unknown hook payload, clock skew on the timestamp key.
- **Architecture conformance:** no Claude Code shape appears above the transformer; the CLI contains
  no classification logic; Effect throughout with `Promise` only at the process boundary.

## Plan

### Approach overview

The mapping package is pure and testable with no Claude Code running — exemplar-driven from real
captured payloads per `.agents/tests.md`. The CLI is deliberately thin: read stdin → transform →
classify → `s3-repository` → exit 0. Keeping the controller that thin is the proof the layering
generalizes; if the CLI accumulates logic, the layering has failed.

The noisy-`Stop` problem is a classification concern, handled in the mapping config, not a
filtering concern in the CLI.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **claude-code-event-mapping** — `@personal-events/claude-code`: hook envelope + consumed-event
   schemas (exemplar-driven), the transformer to canonical `Event`, the `claude-code` mapping config,
   and the classification service. *(AWE-161)*
2. **claude-events-cli** — `@alexrmturner/claude-events`: the controller. stdin (`--file` for
   replay), delegate, write via F1's `s3-repository`, exit-0-safe; tsup self-contained bundle, npm
   publish, `settings.json` recipe and README. *(AWE-162)*

### Cross-story contracts

- **The exit-code contract is the inverse of F1's push CLI.** This CLI exits **0** on failure to
  protect the agent session; `event-push` (AWE-213) exits **non-zero** so automation detects
  failure. Both READMEs must say so — two CLIs in one repo with opposite contracts is a real trap.
- **Classification lives in AWE-161, not AWE-162.** The CLI must not contain a priority table.

### Risks

- **Per-turn `Stop` noise.** `Stop` fires every turn; without sensible defaults this floods the
  bucket and every downstream consumer — most visibly F3's notifications. The mapping config must
  default low-value events to low priority or suppressed, and reserve alert-worthy classification
  for the `Notification` "needs you" signal.
- **Hook latency versus delivery reliability.** A detached/fire-and-forget child returns instantly
  but can be reaped when the hook's process group exits, dropping the upload; a synchronous write
  adds ~100–300ms to every turn. AWE-162 must choose a robust detach or accept a short synchronous
  write — the bar is *no perceptible turn latency **and** no silently lost events*.
- **AWS credentials must exist wherever Claude Code runs.** Not every machine has a profile or SSO
  session; the CLI must fail soft and the README must document the credential expectation and a
  least-privilege `s3:PutObject` policy.
- **The hook payload schema is Anthropic-owned and may drift.** Schemas are exemplar-driven and must
  fail soft — documented default classification, never a crash — on unknown shapes or fields.
- **npm publish under `@alexrmturner`** needs scope/org plus publish auth, and it ships the event
  model contract to an external registry. Treat the model as a versioned interface when cutting
  releases.
