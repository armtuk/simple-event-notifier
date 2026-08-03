---
id: local-sync-client
title: Local sync client — poll the bucket, emit events to stdout
type: feature
status: todo:backlog
parent: none
pm-tool: Airtable
functional-area: event-consumers
depends-on: [minimal-event-pipeline]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
branch-name: feature/local-sync-client
---

# Feature: Local sync client — poll the bucket, emit events to stdout

## Definition

### Problem

After F1 the bucket accumulates events and nothing reads them. The write path is proven; the read
path is not. Until something consumes the bucket continuously, the object-key scheme's central
promise — that lexical order *is* chronological order, so "what happened since I last looked" is a
cheap prefix scan — is an untested assertion.

This feature builds the smallest honest consumer: a long-running local process that notices new
objects quickly and prints them. Deliberately **no notifications** — writing to stdout keeps the
polling, cursor and parsing concerns separable and observable before any platform-specific
delivery mechanism is layered on (that is F3).

### Goals

- Detect new objects in the bucket **within about a second** of them appearing.
- Read each new object through the `event-model` schema, so a malformed object is a logged,
  skipped, *named* failure rather than a crash or silent drop.
- Emit each event to **stdout** in a form that is both human-readable and machine-parseable, so the
  process composes with ordinary shell tooling.
- Survive restarts without re-emitting the whole bucket, and without missing events written while
  it was down.
- Be honest about cost: polling every second must not mean listing the entire bucket every second.

### Solution summary

A `sync-client` app built on the `EventRepository` read side from F1. A poll loop uses the
time-ordered key scheme to scan only the current prefix window, tracking a cursor of the
last-seen key. New keys are fetched, decoded through the Application Model schema, and handed to a
stdout emitter. The loop, the cursor and the emitter are separate modules so F3 can substitute a
different sink without touching the polling logic.

Per ADR `2026-08-03-0035-effect-as-default-idiom`, the loop is an `Effect` — `Schedule` drives the
interval and retry, rather than hand-rolled timers.

### Out of scope

- **Desktop or system notifications** — F3.
- **Acknowledging or handling events** (mutating `acknowledged`/`handled`) — the client is
  read-only.
- **The Event UI**, and any hosted/deployed consumer. This runs locally.
- **SNS/SQS fan-out.** This polls, per the README's naive-client philosophy.

### Acceptance criteria

- With the client running, an event pushed via F1's CLI appears on stdout **within one poll
  interval**.
- Restarting the client does **not** re-emit already-seen events, and **does** emit any event
  written while it was stopped.
- A malformed or non-conforming object is logged with enough detail to identify the offending key
  and the reason, is skipped, and **does not stop the loop**.
- Polling does not list the whole bucket per cycle; the listing is bounded by the key scheme's time
  prefix, and the bound is documented.
- Failure modes each produce a clear log and a continuing (or cleanly-exiting) process — never a
  silent stall: missing/expired AWS credentials, bucket unreachable or denied, throttling/5xx from
  S3, and a system clock that has moved backwards.
- stdout is the *only* thing on stdout — all logging and diagnostics go to stderr, so the stream
  can be piped.
- **Architecture conformance:** consumption goes through the Repository; no raw S3 SDK types above
  it. Effect throughout, per both ADRs.

## Plan

### Approach overview

Two stories split along the seam that F3 will later exploit. The first owns *noticing* — the poll
loop, the prefix window, the cursor, and restart behaviour. The second owns *interpreting and
emitting* — decoding through the schema, the output format, process lifecycle and configuration.
Keeping the sink behind a narrow interface is the whole point: F3 adds a notifier by providing a
different implementation, not by editing the loop.

### Story decomposition

Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **s3-poll-core** — the polling loop: time-prefix-bounded listing, cursor tracking, restart
   semantics, `Schedule`-driven interval and backoff, and the read-side `EventRepository` methods it
   needs. Re-scoped from the former desktop-notifier story. *(AWE-152)*
2. **stdout-emitter-and-daemon** — decode each new object through the Application Model, the stdout
   output format, the sink interface F3 will implement, plus configuration, stderr logging and
   process lifecycle. *(AWE-216)*

### Cross-story contracts

- **The sink interface is defined in AWE-216 and is the extension point for F3.** It takes a
  decoded `Event`; it never sees an S3 key, an object body, or an SDK type.
- **Cursor persistence location** is decided in AWE-152 and must survive restart; AWE-216's
  lifecycle code owns when it is flushed.

### Risks

- **"Poll every second" versus S3 `LIST` cost and rate limits.** A naive full-bucket listing per
  second is both slow and expensive as history accumulates. The time-prefix window is the mitigation
  and must be designed deliberately, including what happens at an hour/day boundary rollover.
- **Clock skew and late writers.** A producer with a skewed clock can write a key that sorts
  *before* the cursor and is therefore never seen. AWE-152 must state the overlap/lookback window
  that bounds this, and accept that it cannot be eliminated while producers stamp their own time.
- **S3 list-after-write consistency** is strong for new objects, but a key written with an
  out-of-order timestamp still lands behind the cursor — this is a key-scheme consequence, not an
  S3 one, and must be documented rather than assumed away.
- **AWE-152 carries a pre-restructure plan** written for a notifier daemon (including a
  `toasted-notifier` adapter). It is `todo:backlog` and needs a `/plan-story` re-run; the
  notification portion of that plan now belongs to F3.
