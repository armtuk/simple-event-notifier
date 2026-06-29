---
id: claude-code-integration
title: Claude Code Hook Integration (direct-to-S3 CLI)
type: feature
status: In Planning
parent: none
depends-on: [github-integration]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-06-29
---

# Feature: Claude Code Hook Integration (direct-to-S3 CLI)

> **Dependency note:** the recorded `depends-on: [github-integration]` is coarser than the
> real edge. The **only hard prerequisites** are `integration-core` (**AWE-153**, which lives
> in the github-integration feature) plus `event-model` (**AWE-150**) and the S3 bucket
> (**AWE-151**) from `bootstrap-and-iac`. This feature needs **none** of GitHub's webhook
> handler / poller / ingest-infra. If `/execute-remaining-features` is ever used, this edge
> over-serializes Claude behind all of GitHub — schedule manually once AWE-153 + bootstrap
> land, or revisit extracting `integration-core` into its own feature.

## Definition

### Problem
LLM agent sessions are one of the README's first-class event sources — specifically *"when
prompts complete"* and *"when the LLM has a question."* Claude Code already emits exactly
these moments as **hooks** (`Stop`, `Notification`, `SubagentStop`, `SessionStart/End`), with
a JSON payload on stdin. We need those moments to land in the canonical event model on S3
alongside GitHub and Slack, so any client (desktop notifier, phone, UI) sees "your agent
finished" / "your agent is waiting on you" in the same triage stream as everything else.

Crucially, a Claude Code hook runs **on every machine the user runs Claude Code on** — desktop,
laptop, servers — not in one deployed service. So the ingestion mechanism must be trivially
installable anywhere and must never add latency to, or break, an interactive agent turn.

### Goals
- Ingest Claude Code session moments — **prompt complete** (`Stop`) and **agent needs the user**
  (`Notification`), plus `SubagentStop` / `SessionStart` / `SessionEnd` — into S3 as canonical
  events, classified config-driven (which are alerts vs notifications, at what priority).
- **Direct, infra-free path:** the hook invokes a thin CLI that writes the event object
  **straight to S3 using the machine's ambient AWS creds** — no webhook, no API Gateway, no
  Lambda. (Decision below; the producer is already in a trusted local environment with creds.)
- **Installable everywhere:** ship the CLI as a published npm package under the user's
  `@alexrmturner` scope so any machine wires it up with `npx` / a global install, independent of
  a monorepo checkout.
- **Never harms the session:** the hook returns effectively instantly and a failure to reach S3
  logs and exits 0 — it must never block a turn or crash Claude Code.
- Reuse the `integration-core` template (AWE-153): a `source: "claude-code"` mapping config
  classifies events → `eventType` + `priority`; the framework transform is untouched.
- **Extract the shared S3 writer** (`@personal-events/s3-push`) now that three+ producers need
  it (this CLI now; GitHub webhook handler + poller and the Slack client later), so the
  "canonical Event → object key → PutObject" logic exists exactly once.

### Solution summary
Three workspace packages, mirroring (and factoring out from) the GitHub/Slack shape:

- **`@personal-events/s3-push`** — a shared, write-only S3 event writer: given a canonical
  `Event` (from `event-model`) it builds the `{timestamp}.{type}.{priority}.{source}.{name}.json`
  object key via the event-model codec and `PutObject`s it with the **AWS SDK v3 default
  credential chain** (ambient creds), idempotently (conditional put / `If-None-Match`). It is
  the **Persist** boundary in G-C-P terms, with typed (`Either`/object) results. Reused by this
  CLI immediately and retrofittable into the GitHub/Slack runtimes.
- **`@personal-events/claude-code`** — effect-Schema validators for the Claude Code hook
  envelope and the consumed hook events (exemplar-driven from real payloads), the
  `source: "claude-code"` mapping config JSON (`hook_event_name`/state → `eventType` + priority,
  most-specific-first with a documented default), and a pure normalizer that extracts the
  canonical fields (session id, project/`cwd`, transcript ref, a human-readable name) and drops
  noise. Pure and testable; reuses `integration-core`.
- **`@alexrmturner/claude-events`** — the **publishable CLI** the hook invokes. It reads the
  hook JSON from **stdin** (the Claude Code hook contract; `--file <path>` accepted for
  replay/testing), validates + maps via `integration-core` + the `claude-code` mapping, and
  writes via `s3-push`. The upload is **detached / fire-and-forget** so the hook returns in
  milliseconds; any failure logs to stderr and the process **exits 0**. It is bundled
  self-contained with `tsup` (private `@personal-events/*` deps inlined) and published to npm,
  so `npx @alexrmturner/claude-events` works on any machine. Ships a documented `settings.json`
  hook-wiring recipe and README.

**Why direct-CLI over a webhook or a local daemon (the decision the intent asked for):** the
producer runs locally with AWS creds already present, so posting to a public ingest endpoint
(AWE-155) is pure indirection plus an auth/edge surface for no benefit. A local spool + flusher
daemon decouples latency but adds a long-lived process to build and babysit — over-engineered
for an event rate of a few per minute. Direct `PutObject` from a detached child gives the
simplicity of the README's "naive client just writes JSON to S3" with no added turn latency. The
mapping/normalizer are written transport-agnostically so a spool/daemon could be added later
with no classification changes if latency or offline-buffering ever demands it.

### Out of scope
- The **webhook ingest** path (API Gateway + Lambda, AWE-155) for Claude events — direct write
  is used instead. The CLI is structured so an HTTP transport could be added later without
  touching the mapping.
- A **local spool / background flusher daemon** and offline buffering — noted as a future
  evolution if `PutObject` latency or offline operation becomes a problem.
- **Retrofitting** the GitHub/Slack runtime stories to consume `@personal-events/s3-push` —
  this feature *creates* the package and is its first consumer; converting the others is tracked
  against their own stories (see Risks).
- Hooks beyond the session-signal set (e.g. `PreToolUse`/`PostToolUse`/`UserPromptSubmit`
  firehose) — they may be added later via config, but are not wired by default.
- The SNS/SQS fan-out & multi-client subscription queue (separate feature); consumers read S3.
- The Event UI.

### Acceptance criteria
- **Direct write works:** with the CLI installed and the `settings.json` hooks wired, completing
  a Claude Code turn (`Stop`) and Claude pausing for the user (`Notification`) each produce a
  canonical event object in S3, classified per the `claude-code` mapping config; `source` is
  `claude-code` and the key follows the event-model scheme.
- **No turn latency, no session breakage:** the hook command returns effectively instantly
  (upload detached); a failure to reach S3 (missing/invalid AWS creds, unreachable bucket)
  produces a clear stderr log and **exit 0** — it never blocks or crashes the Claude session.
- **Config-driven classification:** changing whether a hook event is an alert vs notification, or
  its priority, is a JSON edit with no code change; the config is schema-validated and an
  unmapped event hits a **documented default** rather than being dropped.
- **Installable anywhere:** `npx @alexrmturner/claude-events` (or a global install) runs the CLI
  on a machine with no monorepo checkout; the published bundle is self-contained.
- **Shared writer extracted:** `@personal-events/s3-push` builds the object key via the
  event-model codec, `PutObject`s with the AWS SDK v3 default credential chain, is idempotent
  (re-writing the same key does not create a duplicate or error), returns typed results, and is
  consumed by the CLI (not an inline copy).
- **Idempotency:** the same hook delivery (session + event identity) does not double-write to S3
  across retries/replays.
- **Failure modes** each produce clear logs and graceful handling — no crash, no lost session,
  no dupes: missing AWS creds, unreachable/denied bucket, malformed/unknown hook payload, and a
  machine clock skew on the timestamp key.
- **Guidance conformance is definition-of-done for every story** (per `.agents/general.md` + the
  TypeScript/Effect guidance: G-C-P separation with `s3-push` as the Persist boundary, module
  SRP, pure transforms + slice-don't-dump, no accumulator loops, `Either`/object result types,
  no enums, `Record` lookups over if/else chains), verified by `biome` + `typecheck`.

## Plan

### Approach overview
Build bottom-up and compose at the top. **`s3-push`** and **`claude-code` mapping** are
independent of each other (one is the Persist boundary, the other is pure Gather→Compute
classification) and can be built in parallel; both depend only on `event-model` (and the mapping
additionally on `integration-core`). The **CLI** is last: it is the thin composition layer —
read stdin → `integration-core.transform(claudeConfig, raw)` → `s3-push` → exit-safe — plus the
distribution concerns (tsup self-contained bundle, npm publish under `@alexrmturner`) and the
hook-wiring recipe. Keeping the runtime this thin is the proof the template generalizes to a
third source with almost no new logic. Two Claude-specific reconciliations live in the mapping:
the `Stop`/`SubagentStop` "completed" signals vs the `Notification` "needs-you" signal map to
different `eventType`s, and the noisy per-turn `Stop` must be classifiable low/suppressible so it
does not flood the bucket or every downstream notifier.

### Story decomposition
Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **s3-push-package** — `@personal-events/s3-push`: shared write-only S3 event writer; builds
   the object key via the event-model codec and `PutObject`s with the AWS SDK v3 default
   credential chain, idempotent, typed results. The rule-of-three extraction reused by all
   producers. *(AWE-160)*
2. **claude-code-event-mapping** — `@personal-events/claude-code`: effect-Schema validators for
   the hook envelope + consumed events (exemplar-driven), the `source: "claude-code"` mapping
   config JSON, and the normalizer (canonical-field extraction + noise filtering). Reuses
   `integration-core`. *(AWE-161)*
3. **claude-events-cli** — `@alexrmturner/claude-events`: the publishable CLI the hook invokes —
   read hook JSON from stdin (`--file` for replay), map via `integration-core` + the claude-code
   mapping, write via `s3-push`, detached + exit-0-safe; tsup self-contained bundle, npm publish,
   and the `settings.json` hook-wiring recipe + README. *(AWE-162)*

### Risks
- **`s3-push` is a cross-cutting extraction.** Its value depends on the GitHub/Slack runtime
  stories (github-webhook-handler AWE-156, github-notifications-poller AWE-157,
  slack-socket-mode-client AWE-159) **consuming** it rather than re-implementing their own write.
  Those stories should be updated to depend on / use `s3-push` when built; flag it so the writer
  is not duplicated three more times.
- **Hook latency vs delivery reliability.** A detached/fire-and-forget child returns instantly
  but can be reaped when the hook's process group exits, dropping the upload; a synchronous
  `PutObject` is reliable but adds ~100–300ms to every turn. The CLI story must choose a robust
  detach (e.g. `spawn` detached + `unref`, double-fork/`nohup`) or accept a short synchronous
  write — the bar is *no perceptible turn latency **and** no silently lost events*.
- **AWS creds must exist wherever Claude Code runs.** Not every machine will have a profile/SSO
  session; the CLI must fail soft (log + exit 0) on missing creds and the README must document
  the credential expectation (shared profile / SSO / least-priv `s3:PutObject` to the bucket).
- **Per-turn `Stop` noise → bucket + notifier flood.** `Stop` fires every turn; without
  sensible defaults this spams S3 and any consumer (e.g. the desktop notifier AWE-152). The
  mapping config must default low-value events to low priority or suppressed, and the
  "needs-you" `Notification` to a higher, alert-worthy classification.
- **npm publish under `@alexrmturner`.** First publish needs the scope/org + publish auth + a CI
  or manual release step, and the bundled `event-model` contract version is now shipped to an
  external registry — treat the event model as a versioned interface when cutting releases.
- **Hook payload schema is Anthropic-owned and may drift.** Schemas are exemplar-driven and must
  fail-soft (documented default classification, never a crash) on unknown shapes/fields.
- **Depends on `integration-core` (AWE-153) + `event-model`/S3 (`bootstrap-and-iac`)** — see the
  dependency note above; the recorded edge over-serializes behind all of GitHub.
- **New architecture element:** write a short **ADR** for the direct-CLI (vs webhook vs daemon)
  decision and the `s3-push` extraction.
