---
id: slack-integration
title: Slack Integration (Socket Mode)
type: feature
status: Abandoned
parent: none
depends-on: [github-integration]
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-07-19
---

# Feature: Slack Integration (Socket Mode)

> **ABANDONED 2026-07-19 — shelved for lack of Slack app-creation permissions.** Receiving
> Slack events requires creating an internal Slack **App** (bot token `xoxb-` + app-level token
> `xapp-`), and the user does not currently have rights to create one in the target workspace.
> There is **no personal-token-only path** for Slack, so no fallback ingestion mechanism exists
> to plan around it (unlike GitHub, which has the Notifications-API poller). Nothing else in the
> plans tree depends on this feature, so shelving it blocks no other work.
>
> Per `.agents/guidance/planning-artifacts.md` §3, `Abandoned` is **terminal and never reopened**.
> If Slack permissions are granted later, re-plan it as a **new feature** (`/plan-feature`) rather
> than resurrecting these files; the analysis below stays valid as reference input.

> **Dependency note:** the recorded `depends-on: [github-integration]` is coarser than the
> real edge. The **only hard prerequisite** is `integration-core` (**AWE-153**, which lives in
> the github-integration feature) plus `event-model`/S3 from `bootstrap-and-iac`. Slack needs
> **none** of GitHub's webhook handler / poller / ingest-infra. If `/execute-remaining-features`
> is ever used, this edge will over-serialize Slack behind all of GitHub — schedule manually
> after AWE-153 lands, or revisit extracting `integration-core` into its own feature.

## Definition

### Problem
Slack DMs, @mentions, and messages in a few watched channels are high-signal "someone needs
me" events that should land in the canonical event model on S3 alongside GitHub. Unlike GitHub
there is **no personal-token-only path** — receiving Slack events requires a Slack **App** — but
for a single personal workspace an **internal (undistributed) app over Socket Mode** needs no
public URL, no API-Gateway dependency, and (usually) no admin approval. Classification (which
Slack events are alerts vs notifications, and at what priority) must be config-driven, reusing
the integration template GitHub established.

### Goals
- Ingest Slack **DMs (`message.im`)**, **@mentions (`app_mention`)**, and messages in an
  **allowlist of channels (`message.channels`)** into S3 as canonical events.
- Run over **Socket Mode** from a persistent **Railway** service — no public endpoint, no
  signing-secret HTTP handshake, behind-NAT friendly.
- Reuse `integration-core` (AWE-153): a `source: "slack"` mapping config classifies events →
  `eventType` + `priority`; the framework transform is untouched.
- Be robust: no bot-message loops, no duplicate S3 events (`event_id` idempotency), graceful
  auto-reconnect, and clean handling of noisy `message` subtypes.

### Solution summary
A self-created **internal Slack app** (single workspace) with a **bot token (`xoxb-`)** and an
**app-level token (`xapp-`, scope `connections:write`)** connects via **Socket Mode** using
`@slack/bolt`'s `SocketModeReceiver` on a Railway service. A `@personal-events/slack` package
provides effect-Schema validators for the Slack event envelope + the events we consume
(exemplar-driven), a `source`-discriminated **mapping config** (eventType → channelType /
subtype / channel / keyword → alert|notification + priority, most-specific-first with a
default), and a normalizer that filters bot/own/noisy messages and extracts canonical fields.
Events run through `integration-core.transform` → `event-model` → S3, deduped by `event_id`.

### Out of scope
- The **HTTP Events API** transport (URL verification + signing-secret HMAC) — Socket Mode was
  chosen; the mapping/normalizer are written so an HTTP handler could be added later with no
  classification changes.
- **Replying** to Slack / posting messages (`chat:write`) — read-only ingestion.
- **User tokens (`xoxp-`)** and reading human-to-human DMs — not needed (bot token covers
  DMs-to-the-bot, mentions, and channels the bot is invited to).
- **Distributed / Marketplace** app + multi-workspace OAuth install flow.
- **History backfill** via `conversations.history` — real-time events only (also avoids the
  2025 non-Marketplace history rate cuts; internal apps are exempt regardless).
- Secondary-processing execution (interface only, per the integration template).

### Acceptance criteria
- **App setup documented** (ADR/README): it requires a Slack **App** (internal/undistributed),
  the bot scopes (`app_mentions:read`, `im:history`, `channels:history` for allowlisted public
  channels; add `groups:history`/`mpim:history` if needed), the **app-level token** with
  `connections:write`, and that a personal workspace self-installs without admin approval
  (a workspace that restricts apps to "pre-approved" would need an admin).
- **Ingestion:** with the app running, a DM to the bot, an @mention, and a message in an
  allowlisted channel each become a canonical event on S3, classified per the Slack mapping
  config; an event with no matching rule hits the documented default rather than being dropped.
- **Config-driven:** changing an event's alert/notification classification or priority is a
  JSON edit; the config is schema-validated.
- **No loops / no noise:** the bot's own messages and other bots (`bot_id` present / own
  `api_app_id`) are ignored; noisy subtypes (`message_changed`, `message_deleted`,
  `bot_message`, channel join/leave, …) are dropped; only genuine human messages (absent
  `subtype`) in scope are ingested.
- **Idempotency:** dedupe by `event_id` so reconnects/redeliveries don't double-write to S3.
- **Resilience:** the Socket Mode connection auto-reconnects (the Node SDK uses linear backoff);
  a dropped connection recovers without manual intervention; missing/invalid tokens fail with a
  clear log, not a crash-loop.
- **Guidance conformance is definition-of-done** (per `.agents/general.md` + TS guidance), same
  as the other features.

## Plan

### Approach overview
Two stories, mirroring (a slimmer version of) the GitHub feature. The **mapping package** comes
first (pure, testable — schemas + `source: "slack"` config + normalizer), then the **Socket
Mode client** (the Railway service that connects, filters, maps, and writes). Both reuse
`integration-core` and `event-model`; the classification config is the only Slack-specific
"logic," keeping the runtime thin. Because Slack is the template's second instance, getting it
working with so little new code is the proof the template generalizes.

### Story decomposition
Ordered by dependency. Each is a coherent ~1hr-review increment (not a micro-PR).

1. **slack-event-mapping** — `@personal-events/slack`: effect-Schema validators for the Socket
   Mode event envelope + consumed events (exemplar-driven), the `source: "slack"` mapping config
   JSON, and the normalizer (bot/own/noisy-subtype filtering, channel allowlist, canonical-field
   extraction). *(AWE-158)*
2. **slack-socket-mode-client** — the Railway persistent service: `@slack/bolt` Socket Mode
   client (bot + app-level tokens) subscribing to `app_mention` / `message.im` /
   `message.channels` (allowlist), mapping via AWE-158 → S3, `event_id` dedupe, auto-reconnect,
   winston logging, Railway deploy (Dockerfile + health route + env secrets). *(AWE-159)*

### Risks
- **Slack requires an app (no PAT path):** unavoidable; mitigated by using an internal,
  self-installable app for a personal workspace (no Marketplace, usually no admin approval).
- **`@slack/bolt` is CJS-only** (v4.7.x; v5 RC still CJS): consume via `esModuleInterop` default
  import in our ESM project; verify the Node-24 Lambda-handler fix is irrelevant here (Socket
  Mode path) but confirm Bolt runs clean on Node 24.
- **Bot-loop / subtype noise:** the #1 Slack footgun — must filter on `bot_id` presence (not
  `subtype === "bot_message"`) and treat absent `subtype` as the human-message signal.
- **Socket Mode is stateful / single-connection:** not horizontally scalable and must stay
  connected; rely on `autoReconnectEnabled` and monitor (some reports of delivery stalls on
  long Railway uptimes).
- **Channel allowlist requires inviting the bot** to each watched channel and the broader
  `channels:history` scope; keep the allowlist explicit to avoid a firehose.
- **Railway → AWS:** the service needs AWS creds to write S3 (alongside the Slack tokens).
- **New architecture element:** write a short ADR for the Slack transport choice (Socket Mode
  vs Events API) and the internal-app decision.
- **Prereq:** `integration-core` (AWE-153) and `event-model`/S3 (`bootstrap-and-iac`) must exist
  first (see dependency note above).
