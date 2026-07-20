---
id: 2026-07-19-2130-integration-template-and-dual-path
title: A config-driven integration template, and dual-path (webhook + poller) ingestion for GitHub
status: Accepted
created: 2026-07-19
updated: 2026-07-19
supersedes: none
superseded-by: none
---

# A config-driven integration template, and dual-path (webhook + poller) ingestion for GitHub

## Decision

Every event source in personal-events is built from the **same template**, and GitHub — the first
concrete source — is ingested by **two independent paths** that converge on that template.

**The template** is `@personal-events/integration-core`: a pure, provider-agnostic package holding
the classification machinery and nothing else.

- A **mapping config** (JSON, validated by an effect `Schema`) is the only place that decides
  whether a provider event is an `alert` or a `notification`, at what priority, under what name.
  Changing any of those is a data edit; the framework and the provider code are untouched.
- Each rule matches a **`channel`-discriminated trigger** — a `channel` tag plus a flat bag of
  string match-fields — reduced to a canonical, order-independent `matchKey`. The discriminant is
  named `channel`, **not** `source`, because `source` already means the provider identity on a
  canonical `Event` (`"github"`); one object carrying two meanings of "source" is the confusion this
  naming removes. A channel names *how the event reached us*: `webhook`, `notification`, `events_api`.
- A config is **compiled once** (`compileMappingConfig`) into a `ReadonlyMap` keyed by `matchKey`,
  so classification is an O(1) lookup per event rather than a scan of every rule.
- `transform(compiled)(normalizedEvent)` is the one piece of business logic: pure, no clock, no I/O.
  It re-validates its candidate through `parseEvent` rather than casting, so a bad config value or a
  sloppy normalizer becomes a typed `Left` at the edge instead of an unparseable object key in
  permanent history.
- The **default** classification is mandatory in the schema. An unrecognised trigger is classified
  and written, never dropped.
- `SourceAdapter` and `SecondaryProcessor` are **interfaces only**. No adapter and no processor is
  implemented in the template, and nothing executes a secondary processor yet.

**The provider instance** is `@personal-events/github`: effect Schemas for the subset of each
GitHub shape we read, a real `Schema.Union` of literal-tagged triggers (so a webhook `event`+`action`
and an inbox `reason` are non-confusable at compile time) that decodes *to* the framework's open
trigger shape, the GitHub mapping config JSON, and pure normalizers. It knows GitHub's wire formats
and nothing about classification.

**The dual path.** GitHub is ingested two ways, because which one is available is a *permissions*
question the user may not control:

- **Webhook** — an API Gateway HTTP API in front of a Lambda (`apps/webhook-ingest`), verified with
  `X-Hub-Signature-256` HMAC over the raw body, deduped on `X-GitHub-Delivery`. Rich and real-time,
  but requires repo-admin or org-owner rights to configure.
- **Poller** — a long-running Railway service (`apps/github-poller`) that conditionally polls the
  Notifications inbox (which requires a **classic** PAT) and the Events API. Lower fidelity and
  higher latency, but needs no administrative rights at all.

Both paths write through one shared `@personal-events/event-sink` `S3EventRepository`, so the
object-key scheme and the write path exist exactly once.

## Context

`system.md` names GitHub and LLM agents as the first sources, with email, calendar, incidents,
ticketing and more on the roadmap. Building GitHub as a one-off would mean re-deciding
classification for every one of those, in code, each time — and classification is precisely the part
the user will want to tune repeatedly without a deploy.

The dual path exists because the feature's central risk is **permission uncertainty**. Webhooks are
the better source in every technical respect, and are unavailable to a user who is merely a
contributor on the repositories they care about. A design that only supports webhooks fails for that
user completely; the poller degrades instead, using only a personal token.

Two further forces shaped the template's boundaries:

- **GitHub's two namespaces do not agree.** A webhook says `pull_request` + `review_requested`; the
  inbox says `reason: review_requested`. The values overlap and the meanings do not. Making
  `channel` the discriminant, and making the provider's trigger a literal-tagged union, is what
  stops one being silently matched by the other's rule.
- **GitHub does not retry failed deliveries** (only manual redelivery, for three days) and expects a
  2xx within roughly ten seconds. So the webhook handler must be fast and synchronous, and the
  poller — not a retry queue — is the practical backstop for a lost delivery.

## Blast radius

- **New packages**: `@personal-events/integration-core`, `@personal-events/github`,
  `@personal-events/event-sink`. **New apps**: `apps/webhook-ingest` (Lambda),
  `apps/github-poller` (Railway).
- **`@personal-events/event-model`** is consumed, not changed: `integration-core` imports its field
  schemas (`Priority`, `NoDotString`, `IsoInstant`) rather than restating the bounds, so the 1–8
  range and the no-dot rule have exactly one home.
- **Terraform** (`infra/personal-events`) gains a Lambda, an HTTP API, an ACM certificate and DNS
  records under the delegated zone, an SSM SecureString parameter, an S3 lifecycle rule for delivery
  markers, and a least-privilege IAM user for the Railway poller.
- **Every future integration** — Claude Code next — is a mapping config plus a normalizer against
  this template. If a future source cannot be expressed as `(channel, string fields) → output`, the
  template is what has to change, and that change ripples to every integration already built on it.
- **Operators** gain two credentials to manage (a webhook HMAC secret in SSM, a classic PAT in
  Railway) and one JSON file to tune classification in.

## Alternatives & trade-offs

**Hardcoded per-provider classification** (rejected). Simplest to write once; it makes every
priority tweak a code change and a deploy, and guarantees the next five integrations each re-invent
the same `switch`.

**A rules engine / expression language in the config** (rejected). Predicates over arbitrary payload
fields would be more expressive than a flat match-key. It also makes the config unvalidatable ahead
of time, makes classification untestable without payloads, and turns a data file into a program. The
flat trigger is deliberately weak: everything it cannot express belongs in a normalizer, which is
typed and tested.

**`source` as the trigger discriminant** (rejected, and named in the story stubs). It collides with
the canonical `Event.source`. `channel` is the rename applied consistently across the feature.

**Webhook only** (rejected — this is the feature's core risk). Best fidelity, unavailable without
admin rights.

**Poller only** (rejected). Works for everyone, but loses real-time delivery and full payloads, and
burns rate-limit budget continuously.

**A GitHub App instead of PATs** (deferred, not rejected). It would unify the credential story and
raise the rate limit. It also requires app registration and installation on every target
repository/org — the same administrative rights whose absence motivated the poller. Noted as a
future option.

**One shared S3 write path vs. one per producer** (decided: shared). The object key *is* the
contract's index; two implementations of it would drift, and a drifted key is silent, permanent
event loss rather than a visible error.

## Reversibility

**Two-way door for the template's internals, one-way for its shape.** `compileMappingConfig`,
`classify` and `transform` are pure functions with no persisted state — rewriting them costs a
change to their consumers and nothing else. The *shape* of a mapping config, however, becomes an
operator-authored artifact per integration, and the `channel` vocabulary is baked into every
config's `matchKey`s; changing either means rewriting every config in step.

The dual path is genuinely two-way: each limb is independently deployable and independently
removable, and neither is required for the other to work. Nothing written to S3 records which path
produced it beyond the payload itself, so retiring a path leaves the history intact and readable.

## Known limitation carried, not solved: same-instant siblings

The poller's Notifications path takes its `timestamp` from the item's `updated_at`, which GitHub
emits at **second** precision. Normalised into the contract's mandatory three-digit millisecond
fraction, every notification in a batch that shares a second shares a millisecond — so object keys
that differ only in `name`/`priority` sort adjacently and, for a consumer using a bare high-water
mark, indistinguishably by time.

This is the ordering hazard already recorded in `packages/event-model/README.md` § "Key order is not
write order" and in `.agents/plans/bootstrap-and-iac/feature.md` § Follow-up candidates — but for
this producer same-instant siblings are the **norm rather than the coincidence**. It is recorded
here and in `.agents/plans/github-integration/feature.md`; it is **not fixed here**, because the fix
(a lookback poll window plus a delivered-key set) requires a product decision on delivery semantics
— at-most-once versus retry-until-delivered versus quarantine-and-continue — that has not been made.

## References

Feature plan: `.agents/plans/github-integration/feature.md` (AWE-153 … AWE-157).
Builds on ADR `2026-07-19-1900-iac-foundation` (the Terraform substrate this feature extends).
