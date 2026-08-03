---
id: AWE-216
title: Stdout emitter, sink interface & daemon lifecycle
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-03
---

# Story: Stdout emitter, sink interface & daemon lifecycle

## Definition

### User story

As someone running the sync client in a terminal
I want each new event decoded and printed in a form I can read and pipe
So that I can see what the system is capturing, and so that a later notifier can be attached
without touching the polling loop.

### Acceptance criteria

- Each new object surfaced by the poll core (AWE-152) is decoded through the `event-model`
  Application Model schema before anything downstream sees it.
- A **`Sink` interface** is defined, taking a decoded `Event`. It never receives an S3 key, an
  object body, or an AWS SDK type. This is the extension point F3's notifier implements.
- A stdout sink implements it, emitting one line per event in a format that is both human-readable
  and machine-parseable, carrying at minimum timestamp, `eventType`, `priority`, `source` and `name`.
- **stdout carries events only.** All logging, diagnostics and errors go to stderr, so the stream
  can be piped without contamination.
- Multiple sinks can be registered and each receives every event; one sink failing does not prevent
  the others from receiving it, nor stop the loop.
- Configuration (bucket, poll interval, output format, log level) is resolved with a documented
  precedence, and an invalid configuration fails at startup with an actionable message rather than
  midway through the first poll.
- The process handles `SIGINT`/`SIGTERM` cleanly: it stops polling, flushes the cursor, and exits
  non-zero only on genuine failure.
- **Failure modes** each log clearly and keep the process healthy: an object that fails schema
  decode (logged with its key and the reason, then skipped), a sink that throws, and a
  configuration value that is present but nonsensical.
- Guidance conformance: Effect throughout per ADR `2026-08-03-0035-effect-as-default-idiom`, with
  `Promise` only at the process entry point; G-C-P separation; the decode step is a pure boundary.

### Notes / Open questions

- **The `Sink` seam is the whole point of splitting this story from AWE-152.** If it ends up
  hard-coded to stdout, F3 becomes a refactor of this feature rather than an addition to it. Treat
  the interface as the deliverable, not the stdout implementation.
- **Open — output format.** Candidates: NDJSON (pipes into `jq` trivially, less readable raw), a
  columnar human format (readable, awkward to parse), or both behind a `--format` flag. Leaning to
  both with NDJSON as the default when stdout is not a TTY.
- **Open — where multiple sinks are composed.** Either the loop fans out to a sink list, or a
  single composite sink wraps the others. The latter keeps the loop simpler and is probably right.
- **Open — cursor flush timing** is shared with AWE-152: flushing after every event is safest but
  chatty; flushing per poll cycle risks re-emitting a handful of events after an unclean exit.
  Re-emission is much better than loss, so favour the cheaper option and document it.
- Depends on AWE-152 for the poll core and on F1's `event-model` and `s3-repository`.

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
