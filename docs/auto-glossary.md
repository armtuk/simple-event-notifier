# Project Glossary

Terms of art and non-standard acronyms used across this project's code, plans, and docs. Its
audience is anyone — human or agent — arriving without the project's accumulated context. This
file is **command-maintained** (`/update-glossary`, the planning commands, ADR authoring) but is
a normal tracked doc that a human may edit directly. The glossary **summarizes**; where a term
has a canonical definition elsewhere, the entry links there.

_Last updated: 2026-08-02 — seeded by `/plan-feature` for `event-push-cli`. A full
`/update-glossary` sweep has not yet been run, so coverage is currently limited to the event
model, the push path, and the planning vocabulary they rely on._

## Terms of art

- **Acknowledged** — A boolean flag on an event, independent of *Handled*, that a client sets to
  record that a human has *seen* the event. One half of the triage workflow.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Alert** — One of the two `eventType` values. An event that **requires attention**, as opposed
  to a *Notification*. Which provider events are alerts is config-driven per integration; for a
  *Push* the caller states it explicitly.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Canonical event** — The normalized JSON object every producer writes and every consumer
  reads: `timestamp`, `eventType`, `priority`, `source`, `name`, `acknowledged`, `handled`,
  optional `workItem`, and a provider-specific `payload`. The system's single load-bearing
  contract — treated as a versioned interface.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/bootstrap-and-iac/event-model-package.md).
- **Event model** — The shared package (`@personal-events/event-model`) that defines the
  *Canonical event* schema and the *Object-key codec*. Depended on by every producer and consumer
  so the contract exists exactly once.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/bootstrap-and-iac/event-model-package.md).
- **Functional area** — A durable component area of the system, catalogued in `system.md`. Sits
  **above** features: an area never completes, it accretes features over the system's life. Each
  feature points back to its area via `functional-area:` frontmatter.
  *Canonical:* [`system.md` → Functional areas](../.agents/plans/system.md).
- **Handled** — A boolean flag on an event, independent of *Acknowledged*, recording that the
  underlying issue has actually been dealt with. The other half of the triage workflow.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Naive client** — A consumer that reads events with nothing more than `aws s3 sync` on a cron
  plus an mtime scan. Deliberately blessed as a first-class consumption path: if the naive client
  works, the contract is simple enough.
  *Canonical:* [`README.md`](../README.md).
- **Notification** — One of the two `eventType` values: an **informational** event that does not
  demand action, as opposed to an *Alert*.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Object-key codec** — The parse/build helpers in the *Event model* that convert between a
  *Canonical event* and its S3 object key,
  `{timestamp}.{type}.{priority}.{source}.{name}.json`. The key leads with an ISO timestamp so
  the bucket sorts chronologically by name alone. Normalizes dotted values in `source`/`name` so
  keys stay unambiguously parseable. **Every producer must build keys through this codec** — a
  second implementation would fork the contract.
  *Canonical:* [`event-model-package.md` (AWE-150)](../.agents/plans/bootstrap-and-iac/event-model-package.md).
- **Priority** — An integer 1–8 carried by every event, orthogonal to `eventType`, used by
  consumers to decide how loudly to surface it.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Push** — Writing an event object **directly into the S3 bucket** from a producer that already
  holds AWS credentials, as distinct from *ingest* (arriving via the webhook endpoint). The
  direct-write path used by the Claude Code hook CLI and by the `event-push` CLI.
  *Canonical:* [`event-push-cli/feature.md`](../.agents/plans/event-push-cli/feature.md).
- **Push recipe** — A documented, copy-paste shell snippet that wires some everyday trigger — a
  crontab line, a git hook, a CI step, a long-job completion — to an `event-push` invocation.
  *Canonical:* [`shell-wrapper-and-recipes.md` (AWE-214)](../.agents/plans/event-push-cli/shell-wrapper-and-recipes.md).
- **Source** — The identifier of the originating system on an event (`github`, `claude-code`,
  `cron`, …). Appears both in the *Canonical event* body and as a segment of the object key.
  *Canonical:* [`system.md` → Key cross-cutting context](../.agents/plans/system.md).
- **Work item** — An optional URL on an event pointing at a ticket in an external system, whose
  own workflow and statuses a more sophisticated client may choose to interact with.
  *Canonical:* [`README.md`](../README.md).

## Acronyms & abbreviations

- **ADR (Architecture Decision Record)** — A short document recording an architectural decision
  and its rationale. Required when a new structural element is added, not for routine feature
  work. *Canonical:* [`.agents/guidance/adr.md`](../.agents/guidance/adr.md).
- **AWE** — The ticket prefix for this project's stories in Airtable (e.g. `AWE-213`). Numbers
  are drawn from a **global** counter shared across all projects in the base, so a project's
  ticket numbers are not contiguous.
  *Canonical:* [`.agents/project-tooling/airtable.md`](../.agents/project-tooling/airtable.md).
- **G-C-P (Gather, Compute, Persist)** — The project's core structuring principle: fetch all data
  up front (Gather), run pure functions over it (Compute), then side-effect external systems
  (Persist). *Canonical:* [`.agents/general.md`](../.agents/general.md).
- **IaC (Infrastructure as Code)** — Provisioning infrastructure from version-controlled
  definitions; Terraform here.
  *Canonical:* [`infra-s3-and-dns.md` (AWE-151)](../.agents/plans/bootstrap-and-iac/infra-s3-and-dns.md).
- **PAT (Personal Access Token)** — A GitHub user token. The distinction between **classic** and
  **fine-grained** PATs is load-bearing: the Notifications API accepts only classic PATs, while
  other paths use fine-grained ones.
  *Canonical:* [`github-integration/feature.md`](../.agents/plans/github-integration/feature.md).
