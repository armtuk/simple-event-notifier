---
id: AWE-158
title: Slack event schemas, mapping config & normalizer
type: story
status: Abandoned
parent: ./feature.md
branch: feat/slack-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-07-19
---

# Story: Slack event schemas, mapping config & normalizer

> **ABANDONED 2026-07-19** along with its parent feature `slack-integration` — shelved for lack
> of Slack app-creation permissions. See `./feature.md` for the rationale.

## Definition

### User story
As the Slack integration
I want validated Slack event schemas, a mapping config, and a normalizer
So that the Socket Mode client can turn Slack events into canonical events using the shared,
config-driven classification — with bot loops and noisy subtypes filtered out.

### Acceptance criteria
- A `@personal-events/slack` package provides effect-Schema validators (exemplar-driven, real
  payloads in `exemplars/`) for the Socket Mode **event envelope** and the events we consume:
  `app_mention`, and `message` with `channel_type` `im` / `channels` (and the fields we need:
  `user`, `text`, `channel`, `event_ts`, `subtype`, `bot_id`).
- A **Slack mapping config JSON** conforming to `integration-core`'s `source`-discriminated
  schema, with `source: "slack"` triggers matched **most-specific-first**: e.g.
  `app_mention` → alert/high; `message` + `channel_type: im` (no subtype) → alert/high;
  `message` + allowlisted `channel` (+ optional keyword) → notification/normal; a documented
  **default**.
- A **normalizer** that, before classification: (1) **ignores bot/own messages** by the presence
  of `bot_id` / the app's own `api_app_id` (NOT by `subtype === "bot_message"`); (2) treats an
  **absent `subtype` as a genuine human message** and drops noisy subtypes (`message_changed`,
  `message_deleted`, `bot_message`, channel join/leave, etc.); (3) enforces the **channel
  allowlist** for `message.channels`; (4) extracts canonical fields (`source: "github"`→
  `"slack"`, `name`, `timestamp` from `event_ts`, dotted-segment-safe values per the no-dot
  rule) and hands off to `integration-core.transform`.
- The `event_id` (outer envelope) is carried through as the **idempotency key** for S3 writes.
- Unit tests over exemplars: each event type classifies as expected, a bot/own message is
  dropped (no loop), each noisy subtype is dropped, a non-allowlisted channel message is
  dropped, an unmatched event hits the default, and the normalizer output is a valid canonical
  event.
- **Failure modes:** malformed envelope/event (typed failure, captured), an event with no rule
  (→ default), and values containing dots (normalized so the S3 key stays parseable).

### Notes / Open questions
- Confirm the exact channel allowlist mechanism (config list of channel IDs) and whether keyword
  matching is in v1 — decide in `/plan-story`.
- Open: derive a stable human-readable `name` (e.g. `dm`, `mention`, `channel-message`) — likely
  a small per-trigger label in the mapping config.
- Open: reuse Slack's published TypeScript types (`@slack/types` / Bolt event types) for
  compile-time typing while still authoring effect Schemas for **runtime** validation.
- Depends on `integration-core` (AWE-153, in feature `github-integration`) and `event-model`
  (AWE-150, in `bootstrap-and-iac`).

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This is a
> **pure** package (schemas + config + a deterministic normalizer) — no Slack connection or S3
> here; that's AWE-159. Mirror the GitHub mapping package (AWE-154) as the sibling pattern.

### Decisions resolved during planning (open questions answered)
- **Channel allowlist:** a `channelAllowlist: string[]` of channel IDs in the Slack config;
  `message.channels` events whose `channel` is not in the list are **dropped** by the normalizer
  before classification. **Keyword matching is out of v1** (the trigger schema reserves a
  `keyword` field for later).
- **`name` derivation:** a small per-trigger label resolved from the matched rule — `mention`
  (app_mention), `dm` (message.im), `channel-message` (message.channels). No-dot-safe by
  construction.
- **Typing:** use Slack's published types (`@slack/types`, and Bolt's event typings) for
  compile-time help, but author **effect Schemas** for the subset we consume for **runtime**
  validation of untrusted socket payloads.
- **Timestamp:** Slack `event_ts` is epoch-seconds-with-microseconds (`"1718000000.123456"`);
  convert to an ISO-8601 `…Z` instant for the canonical `Event.timestamp` (the event-model key
  scheme needs the ISO form).

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md and .agents/languages/typescript/typescript.md. -->
- **Pure / total Compute** (`general.md`): schemas, the rule resolver, and the normalizer are
  pure and deterministic — no I/O, no logging side effects. This is the Compute/Transform layer
  AWE-159 calls.
- **Reuse, don't re-implement** (`general.md` DRY + the template intent): the mapping-config
  schema and the `transform(config, rawEvent) → Event` live in **`integration-core` (AWE-153)**;
  this package supplies the **`source: "slack"` config instance** + a Slack normalizer, and must
  not fork the framework. If the framework's trigger union needs a `slack` variant added, that's
  a small change in `integration-core`, surfaced as such.
- **Return Values / Objects** (`typescript.md`): parse/normalize entry points return
  `Either`/object results; never bare `null`/`undefined`. A dropped event is an explicit,
  typed "drop" outcome, not a silent return.
- **No enums** (`as const`/literals); **no accumulator loops** (rule matching via
  `find`/`filter` most-specific-first, not a hand-rolled loop); **`Record`/lookup** over
  if/else chains.
- **Module-level SRP**: `events.ts` (schemas) / `mapping-config.ts` (the slack config + its
  trigger typing) / `normalizer.ts` (filter + canonical extraction) / `index.ts` — one axis of
  change each.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/github-integration/integration-framework.md` (AWE-153) — Why: the mapping-config
  schema, the `source`-discriminated trigger model, and the `transform`/`SourceAdapter` contract
  this package plugs into.
- `.agents/plans/github-integration/github-event-mapping.md` (AWE-154) — Why: the **sibling**
  pattern to mirror (schemas + config + normalizer for a second source).
- `.agents/plans/bootstrap-and-iac/event-model-package.md` (AWE-150) — Why: the canonical
  `Event` shape, the no-dot rule on `source`/`name`, and `buildKey`.
- `.agents/frameworks/effect/v3/_main/schema.md` + `.agents/frameworks/effect/index.md` — Why:
  `Schema.Struct`/`Literal`/`optional`/`Union`, decode-to-`Either`, `pattern` filters.
- `.agents/tests.md` + `.agents/languages/typescript/typescript-testing.md` — Why: exemplar-
  driven specs, happy + sad, co-located `.spec.ts`.

### Files to create / change
- `packages/slack/package.json` — `@personal-events/slack`, `type: module`, deps
  `@personal-events/integration-core` + `@personal-events/event-model` (workspace:*) + `effect`;
  dev `@slack/types` for compile-time payload typing; tsup build, vitest.
- `packages/slack/tsconfig.json` / `tsup.config.ts` — extend base; esm + dts.
- `packages/slack/src/events.ts` — effect Schemas: the `event_callback` envelope (`event_id`,
  `team_id`, `api_app_id`, `event`, `event_time`) + `app_mention` + `message` (with
  `channel_type`, `subtype?`, `bot_id?`, `user`, `text`, `channel`, `event_ts`).
- `packages/slack/src/mapping-config.ts` — the `source: "slack"` config: `channelAllowlist`,
  ordered rules (`{ eventType, channelType?, subtype?, channel?, keyword? } → { eventType:
  alert|notification, priority }`), a default rule, and the per-trigger `name` label.
- `packages/slack/src/normalizer.ts` — `normalize(rawEnvelope) → NormalizeResult` that: drops
  bot/own messages (`bot_id` present OR `api_app_id === ownAppId`), drops non-human/noisy
  subtypes (treat absent `subtype` as human), enforces the channel allowlist for
  `message.channels`, converts `event_ts` → ISO, extracts canonical fields, and calls
  `integration-core.transform` with the slack config.
- `packages/slack/src/index.ts` — public re-exports.
- `packages/slack/exemplars/` — real payloads: `app_mention.json`, `message_im.json`,
  `message_channel.json`, plus drop cases `bot_message.json`, `message_changed.json`,
  `non_allowlisted_channel.json`.
- `packages/slack/src/*.spec.ts` — co-located specs.

### Relevant documentation
- [Slack event object / `event_callback` envelope](https://docs.slack.dev/reference/objects/event-object/)
  — Why: envelope + `event_id`/`authorizations` fields to model.
- [`message` event subtypes](https://docs.slack.dev/reference/events/message/) — Why: the
  subtype list to drop and the "absent subtype = human" rule.
- [`app_mention` event](https://docs.slack.dev/reference/events/app_mention/) — Why: mention
  payload shape.
- [effect Schema basic usage / filters](https://effect.website/docs/schema/basic-usage/) — Why:
  Struct/Literal/optional/pattern for the validators.

### Patterns to follow
- **Human-message filter (critical, from research):**
  `event.type === "message" && event.subtype === undefined && !event.bot_id` → process; anything
  with `bot_id` or a `subtype` is dropped. **Never** key the bot check on `subtype === "bot_message"`.
- **Own-app filter:** drop if the envelope `api_app_id` (or message `bot_id` resolving to our
  bot) is our own app — prevents loops.
- **Rule matching:** most-specific-first over the ordered rule list (eventType → channelType →
  channel → keyword), falling back to the default — expressed with `find`, not a bare loop.
- **`event_id`** is carried out of the normalizer (in the result) so AWE-159 can use it as the
  S3 idempotency key.

### Codebase irregularities to ignore
- Slack's `message` event cannot be subscribed by subtype — all subtype filtering is
  application-side here; don't expect the platform to pre-filter.
- `@slack/*` packages are CJS (relevant to AWE-159's runtime), but **this** package needs only
  `@slack/types` (types-only) — no CJS interop concern here.

### Step-by-step tasks
Execute in order.

#### CREATE packages/slack scaffold
- **IMPLEMENT**: package.json/tsconfig/tsup.config; deps on integration-core + event-model.
- **VALIDATE**: `pnpm --filter @personal-events/slack build`.

#### CREATE src/events.ts (effect Schemas, exemplar-driven)
- **IMPLEMENT**: envelope + app_mention + message schemas; capture real exemplars first.
- **VALIDATE**: `pnpm --filter @personal-events/slack typecheck`.

#### CREATE src/mapping-config.ts (source:slack config)
- **IMPLEMENT**: channelAllowlist, ordered rules, default, name labels; validate against
  integration-core's config schema (extend its trigger union with a `slack` variant if needed).
- **VALIDATE**: a config-parse unit test passes.

#### CREATE src/normalizer.ts (filter + canonical extraction)
- **IMPLEMENT**: bot/own/noisy filtering, allowlist, `event_ts`→ISO, canonical-field extraction,
  hand off to `integration-core.transform`; return a typed drop vs event result carrying `event_id`.
- **VALIDATE**: unit tests over exemplars.

#### REFACTOR — guidance conformance pass (general.md + TS guidance)
- **IMPLEMENT**: module SRP across events/mapping/normalizer; pure functions; no accumulator
  loops in matching/tests; `Either`/object results; no enums; `Record`/find over if/else.
- **VALIDATE**: `pnpm --filter @personal-events/slack exec biome check src` and `… typecheck`
  clean; optionally `/simplify` the diff.

### Testing strategy
- **Unit**: exemplar-driven tables — each in-scope event classifies as expected; bot/own
  message dropped (no loop); each noisy subtype dropped; non-allowlisted channel dropped;
  unmatched event → default; malformed envelope → typed failure; normalizer output is a valid
  canonical `Event`; `event_ts`→ISO conversion correct (incl. microseconds).
- **Integration**: n/a (pure package; the live Socket Mode path is AWE-159).
- **Edge cases**: `message_changed`/`message_deleted` (no top-level `user`), group DM
  (`mpim`), a message whose text contains dots (no-dot normalization of `source`/`name`).

### Validation commands
- Level 1 — Style: `pnpm --filter @personal-events/slack exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/slack typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/slack test`
- Level 4 — Consume: a sibling package can
  `import { normalize, slackMappingConfig } from "@personal-events/slack"` and round-trip an
  exemplar to a canonical event.
