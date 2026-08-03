---
id: AWE-213
title: Event push CLI (@personal-events/event-push)
type: story
status: todo:backlog
parent: ./feature.md
pm-tool: Airtable
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-02
updated: 2026-08-02
---

# Story: Event push CLI (`@personal-events/event-push`)

## Definition

### User story

As someone with a script, cron job, or CI step that just noticed something worth knowing about
I want to push a canonical event into the S3 event bucket with a single command
So that any client — desktop notifier, phone, future Event UI — sees it in the same triage
stream as GitHub and Claude Code events, without me standing up a webhook or hand-building an
object key.

### Acceptance criteria

- A workspace package `@personal-events/event-push` exposes a `bin` entry point that accepts:
  - `--type` (`alert` | `notification`, required)
  - `--priority` (integer 1–8, required)
  - `--source` (required)
  - `--name` (required)
  - `--payload <path|->` (optional; `-` reads stdin)
  - `--work-item <url>` (optional)
  - `--bucket <name>` (optional; overrides every other source of bucket identity)
  - `--dry-run` (optional)
- The assembled event validates against the `@personal-events/event-model` schema before any
  network call is attempted, with `acknowledged` and `handled` defaulting to `false`.
- The object key is produced **exclusively** by the event-model codec. No key string is
  assembled in this package.
- **Round-trip parity is proven by test:** for a matrix of inputs — including `source` and
  `name` values containing dots, and boundary priorities 1 and 8 — the key produced parses back
  through the codec to the identical components.
- The write uses the AWS SDK v3 **default credential chain** (no hardcoded profile) and is
  isolated in a single `putEvent` module whose signature is a drop-in for `@personal-events/s3-push`
  (AWE-160), so it can later be swapped in one file.
- `--dry-run` prints the resolved key and the full event body to stdout, performs **no** network
  call, and exits 0.
- Bucket identity resolves in a documented precedence order (`--bucket` > env var > config),
  and the tool reports which source it used when the resolution fails.
- **Failure modes — each produces a specific, actionable stderr message and a NON-ZERO exit:**
  - `--type` not one of `alert`/`notification`; `--priority` non-integer or outside 1–8;
  - any required flag missing;
  - `--payload` path does not exist, is unreadable, or contains malformed JSON;
  - stdin requested via `-` but empty or not valid JSON;
  - AWS credentials missing, expired, or lacking `s3:PutObject`;
  - bucket does not exist, is unreachable, or returns access-denied.
- Exit codes are distinct enough for a script to branch on usage errors vs. write failures, and
  are documented in the package README.
- Guidance conformance: G-C-P separation (argv/stdin/env gather → pure `buildEvent`/key compute
  → `putEvent` persist), module SRP, `Either`/tagged results at boundaries, no enums, no
  accumulator loops, `Record` lookups over if/else chains. Verified by `biome` + `typecheck`.

### Notes / Open questions

- **Exit-code contract is deliberately the inverse of AWE-162.** `@alexrmturner/claude-events`
  must exit 0 on failure to protect the interactive agent session; this tool must exit non-zero
  so automation can detect a failed push. Both README files should call this out explicitly —
  two CLIs in one repo with opposite failure contracts is an easy trap.
- **Open — timestamp source.** The key leads with the machine clock, so a skewed host produces
  events that sort incorrectly. Decide between client-side stamping (simple, skew-prone) and an
  optional `--timestamp` override for replay and testing. Flagged as a feature-level risk.
- **Open — bucket identity convention.** AWE-151 produces the bucket via Terraform outputs but
  no repo-wide convention exists yet for how runtime components learn the name. This story picks
  a precedence order; if AWE-151 later establishes a different convention, this must follow it.
- **Open — same-key re-push behavior.** Whether a repeated identical command overwrites, errors,
  or no-ops should match whatever idempotency stance AWE-160 settles on (conditional put /
  `If-None-Match`), so the two writers do not disagree.
- Depends on AWE-150 (`event-model`) for the schema and codec, and AWE-151 for a real bucket to
  write to. Does **not** need `integration-core` (AWE-153) — there is no mapping config here;
  the caller states type and priority explicitly.

<!-- ## Plan is filled in later by /plan-story when this story is about to be worked. -->
