---
id: AWE-154
title: GitHub payload schemas, mapping config & normalizer
type: story
status: ready
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-06-29
---

# Story: GitHub payload schemas, mapping config & normalizer

## Definition

### User story
As the GitHub integration
I want validated GitHub payload/notification schemas, a mapping config, and a normalizer
So that both the webhook and polling paths can turn GitHub data into canonical events using one
shared, config-driven classification.

### Acceptance criteria
- A `@personal-events/github` package provides effect-Schema validators for the GitHub data we
  consume: the relevant **webhook event payloads** (e.g. `pull_request`, `issues`, `push`,
  `release`, `pull_request_review` — final list decided in planning) and the **Notification
  object** shape from `GET /notifications` (reason, subject, repository, updated_at). Schemas
  are **exemplar-driven** (real captured payloads in an `exemplars/` dir).
- A **GitHub mapping config JSON** (conforming to `integration-core`'s schema) whose rules use
  a **`source`-discriminated trigger** so the namespaces can't be confused: `webhook`
  (`event` + optional `action`, e.g. `pull_request` + `review_requested`) vs `notification`
  (`reason`, e.g. `review_requested`, + optional `subjectType`) — each mapping to `eventType` +
  `priority`, with a default entry. (A third `events_api` trigger variant is reserved should the
  optional Events API source be adopted — see the poller story.)
- A **normalizer** that, given a validated webhook payload or notification object, extracts the
  canonical fields (`source: "github"`, `name`, `timestamp`, dotted-segment-safe values per the
  event-model no-dot rule) and hands off to `integration-core.transform`.
- Unit tests over exemplars: each event/reason classifies as expected, an unknown name hits the
  default, malformed payloads fail typed, and the normalizer output is a valid canonical event.
- **Failure modes:** an unrecognized/unsupported event-name (→ default classification, logged),
  a payload that fails schema validation (typed failure, captured for inspection), and values
  containing dots (normalized so the S3 key stays parseable).

### Notes / Open questions
- Confirm the **initial event/reason coverage list** during `/plan-story` (start focused: PRs,
  issues, reviews, mentions; expand later).
- Resolved direction: use `@octokit/webhooks-types` (v7.6.1) / `@octokit/openapi-webhooks-types`
  for compile-time payload typing, but still author effect Schemas for the subset we consume so
  we get **runtime** validation (types alone don't validate untrusted input).
- Open: how to derive a stable, human-readable `name` (e.g. `pull_request.opened` →
  `new-pull-request`) — likely a small per-event label in the mapping config.
- Depends on `integration-framework` (AWE-153) and `event-model` (AWE-150).

> **Resolved in planning (2026-06-29):**
> - **Types package (user decision):** use **`@octokit/openapi-webhooks-types@^12.1.0`** for
>   compile-time payload typing — the older `@octokit/webhooks-types@7.6.1` is superseded
>   (octokit v13+ moved to the official OpenAPI-generated types). Compile-time only (no runtime
>   code); our **effect Schemas** remain the runtime validators for untrusted input.
> - **`name` derivation:** config-driven. The human label lives in each rule's `output.name`
>   (e.g. `new-pull-request`); the normalizer supplies a **dot-safe fallback** name (e.g.
>   `pull_request-opened`) used only when a rule has no `name`. This consumes the optional
>   `output.name` added to `integration-core`'s `OutputSchema` in AWE-153.
> - **Trigger discriminant is `channel`** (not `source`) — consistent with AWE-153 (avoids
>   colliding with the canonical `Event.source = "github"`). Values: `webhook`, `notification`,
>   `events_api` (reserved).
> - **Initial coverage list (focused):**
>   - **Webhook events/actions:** `pull_request` (`opened`, `closed`, `ready_for_review`,
>     `review_requested`), `pull_request_review` (`submitted`), `issues` (`opened`, `closed`,
>     `assigned`), `push`, `release` (`published`).
>   - **Notification reasons:** `review_requested`, `mention`, `team_mention`, `assign`,
>     `ci_activity`, `security_alert`.
>   - Anything outside this set → the config `default` (logged as unmapped, never dropped).
> - **Timestamp source:** webhook payloads carry no reliable single event-time, so the
>   **webhook** path takes `receivedAt` (ISO now, injected by the AWE-156 edge — keeps the
>   normalizer pure); the **notification** path uses `updated_at` from the object.
> - **Normalizer is pure; adapters are the edges.** This story ships the pure
>   `normalizeWebhook`/`normalizeNotification` and the mapping config. The concrete
>   `SourceAdapter` impls (I/O) are AWE-156 (webhook) and AWE-157 (poller); they wrap this.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. Depends on
> AWE-153 (`integration-core`) and AWE-150 (`event-model`) being built and green.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
From `.agents/general.md`, `.agents/languages/typescript/*`, `.agents/frameworks/effect/index.md`:
- **Gather / Compute / Persist**: this package is **pure Compute** — schemas, the mapping
  config (data), and the normalizer. **No I/O** (no `fetch`, no S3, no fs except reading the
  bundled mapping JSON which ships with the package). The normalizer takes already-fetched
  `unknown` input + an injected `receivedAt`.
- **Module SRP**: separate the webhook schemas, the notification schema, the trigger schemas,
  the schema registry, the dot-safe util, the normalizer, and the mapping config into their own
  modules.
- **Slice, don't dump**: webhook/notification schemas validate only the **subset of fields the
  normalizer reads**; the full raw object is carried opaquely as `payload` (do not strip it).
- **No accumulator loops**: the schema registry is an `as const`/`Record` object literal, not a
  loop-built map; field extraction is direct property access, not iteration.
- **No enums / no if-else on a discriminator**: webhook-vs-notification handling and
  event-name→schema selection are **`Record` lookups**; channel/eventType are `Schema.Literal`
  unions.
- **Result/error types**: `normalizeWebhook`/`normalizeNotification` return
  `Either<NormalizedEvent, GithubNormalizeError>`; schema validation uses
  `Schema.decodeUnknownEither(...)`. No throws, no `null`/`undefined` returns.
- **Effect Schema** from `"effect"` (v3.21). Read `.agents/frameworks/effect/v3/_main/schema.md`.
- **Non-confusable trigger union**: the GitHub trigger is a real `Schema.Union` of literal-tagged
  structs (webhook | notification | events_api) — this is the type-level guarantee the AC wants;
  it must still **decode to** `integration-core`'s open `{ channel, ...stringFields }` `Trigger`
  shape so `matchKey` lines up with the JSON config rules.
- **Logging**: the normalizer is pure and emits no logs; it returns typed lefts. The *edges*
  (AWE-156/157) log unmapped/invalid per `.agents/guidance/logging.md`.
- **ADR**: covered by the feature ADR authored in AWE-153 — reference it, do not author a new one.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `packages/integration-core/src/index.ts` (from AWE-153) — Why: import `NormalizedEventSchema`,
  `type NormalizedEvent`, `TriggerSchema`, `type Trigger`, `transform`, `compileMappingConfig`,
  `loadMappingConfig`, `matchKey`. **The GitHub trigger must be assignable to `Trigger` and its
  `matchKey` must equal the config rule's `matchKey`.**
- `packages/event-model/src/event.ts` (from AWE-150) — Why: `NoDotString`, `IsoInstant`,
  `Priority` field-schema shapes and the no-dot rule (`/^[^.]+$/`) the normalizer must satisfy.
- `.agents/plans/github-integration/integration-framework.md` (this feature) — Why: the
  `channel`/`name`/`NormalizedEvent` decisions and the `OutputSchema` (incl. optional `name`).
- `@octokit/openapi-webhooks-types` package types — Why: compile-time reference for the webhook
  payload field names so our subset schemas match GitHub's real shapes.
- GitHub REST/webhook docs (see Relevant documentation) — Why: exemplar payload structure and
  the Notification object fields.

### Files to create / change
- `packages/github/package.json` — `@personal-events/github`; deps `effect`,
  `@personal-events/event-model`, `@personal-events/integration-core` (`workspace:*`);
  **dev** dep `@octokit/openapi-webhooks-types@^12.1.0` (types only); standard scripts.
- `packages/github/tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — mirror bootstrap.
- `packages/github/src/notification.ts` — `NotificationSchema` (`id`, `reason`,
  `subject: { title, url, type }`, `repository: { full_name }`, `updated_at`).
- `packages/github/src/webhook-payloads.ts` — subset `Schema.Struct`s: `PullRequestEventSchema`,
  `IssuesEventSchema`, `PushEventSchema`, `ReleaseEventSchema`, `PullRequestReviewEventSchema`,
  plus a permissive `GenericWebhookSchema` (`action?`, `repository?`, `sender?`) for unsupported events.
- `packages/github/src/webhook-schema-registry.ts` — `Record<string, Schema>` mapping
  `X-GitHub-Event` name → schema (default to `GenericWebhookSchema` on miss via `?? `).
- `packages/github/src/github-trigger.ts` — `WebhookTriggerSchema`, `NotificationTriggerSchema`,
  `EventsApiTriggerSchema` (reserved), `GithubTriggerSchema = Schema.Union(...)`.
- `packages/github/src/dot-safe.ts` — `toDotSafe(value: string): string` (replace `.`/whitespace).
- `packages/github/src/normalizer.ts` — `normalizeWebhook`, `normalizeNotification`, and a
  convenience `githubToEvent(compiled) => (input) => Either<Event, GithubNormalizeError | TransformError>`.
- `packages/github/src/errors.ts` — `GithubNormalizeError`, `GithubValidationError` (tagged).
- `packages/github/src/github-mapping.json` — the mapping config (data).
- `packages/github/src/mapping.ts` — imports the JSON, exposes `loadGithubConfig(knownProcessors?)`
  using `integration-core.loadMappingConfig` (returns `Either<CompiledConfig, ConfigError>`).
- `packages/github/src/index.ts` — public re-exports.
- `packages/github/exemplars/` — real captured payloads: `webhook-pull_request-opened.json`,
  `webhook-issues-opened.json`, `webhook-push.json`, `webhook-pull_request_review-submitted.json`,
  `notification-review_requested.json`, `notification-mention.json`, plus `invalid-*.json`.
- Co-located specs: `notification.spec.ts`, `webhook-payloads.spec.ts`, `normalizer.spec.ts`,
  `mapping.spec.ts`, `dot-safe.spec.ts`.

### Relevant documentation
- [GitHub webhook event payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) — Why: exact field shapes for `pull_request`, `issues`, `push`, `release`, `pull_request_review` exemplars.
- [REST: Notifications](https://docs.github.com/en/rest/activity/notifications) — Why: the Notification object (reason/subject/repository/updated_at) the schema validates.
- [`@octokit/openapi-webhooks-types` (npm)](https://www.npmjs.com/package/@octokit/openapi-webhooks-types) — Why: the approved compile-time types package (v12.1.0).
- [Effect Schema getting started](https://effect.website/docs/schema/getting-started/) — Why: `decodeUnknownEither`, `Schema.Union`, `Schema.Literal`.

### Patterns to follow
- **Subset schema carrying raw payload** — validate the slice, keep the original:
  ```ts
  export const PullRequestEventSchema = Schema.Struct({
    action: Schema.String,
    number: Schema.Number,
    pull_request: Schema.Struct({ title: Schema.String, html_url: Schema.String }),
    repository: Schema.Struct({ full_name: Schema.String })
  })
  ```
  The normalizer decodes the raw against this (for safety + extraction) but sets
  `payload = raw` (the untouched object), so no GitHub field is lost downstream.
- **Schema registry (Record lookup, not if/else)**:
  ```ts
  export const webhookSchemas: Record<string, Schema.Schema<unknown>> = {
    pull_request: PullRequestEventSchema, issues: IssuesEventSchema, push: PushEventSchema,
    release: ReleaseEventSchema, pull_request_review: PullRequestReviewEventSchema
  }
  const schemaFor = (eventName: string) => webhookSchemas[eventName] ?? GenericWebhookSchema
  ```
- **Non-confusable trigger union → open Trigger**:
  ```ts
  export const WebhookTriggerSchema = Schema.Struct({
    channel: Schema.Literal("webhook"), event: Schema.String, action: Schema.optional(Schema.String)
  })
  export const NotificationTriggerSchema = Schema.Struct({
    channel: Schema.Literal("notification"), reason: Schema.String, subjectType: Schema.optional(Schema.String)
  })
  export const GithubTriggerSchema = Schema.Union(WebhookTriggerSchema, NotificationTriggerSchema, EventsApiTriggerSchema)
  ```
  Build the trigger value as a plain object so `matchKey` (from integration-core) sees the same
  string fields the JSON config rule has. **GOTCHA**: drop `undefined` optionals before building
  the trigger (e.g. omit `action` entirely for `push`) so `matchKey` matches a config rule that
  also omits `action` — an explicit `action: undefined` vs an absent key must serialize the same.
- **Normalizer (webhook)**:
  ```ts
  export const normalizeWebhook = (input: { eventName: string; deliveryId: string; receivedAt: string; raw: unknown })
    : Either.Either<NormalizedEvent, GithubNormalizeError> =>
    pipe(
      Schema.decodeUnknownEither(schemaFor(input.eventName))(input.raw),
      Either.mapLeft(e => new GithubNormalizeError({ channel: "webhook", eventName: input.eventName, reason: format(e) })),
      Either.map(decoded => ({
        source: "github",
        name: toDotSafe(input.eventName + (hasAction(decoded) ? `-${decoded.action}` : "")),
        timestamp: input.receivedAt,
        trigger: buildWebhookTrigger(input.eventName, decoded),   // omits undefined action
        payload: input.raw as Record<string, unknown>
      }))
    )
  ```
  `notification` path is analogous: validate `NotificationSchema`, `timestamp = updated_at`,
  `trigger = { channel: "notification", reason, subjectType }` (omit `subjectType` if absent),
  `name = toDotSafe(reason)`.
- **Errors** (`Schema.TaggedError`): `GithubNormalizeError({ channel, eventName?, reason })`,
  `GithubValidationError`.
- **Mapping JSON** (`src/github-mapping.json`) — channel-discriminated rules + default, e.g.:
  ```json
  {
    "integration": "github",
    "rules": [
      { "trigger": { "channel": "webhook", "event": "pull_request", "action": "opened" },
        "output": { "eventType": "alert", "priority": 5, "name": "new-pull-request" } },
      { "trigger": { "channel": "webhook", "event": "pull_request", "action": "review_requested" },
        "output": { "eventType": "alert", "priority": 6, "name": "review-requested" } },
      { "trigger": { "channel": "notification", "reason": "review_requested" },
        "output": { "eventType": "alert", "priority": 6, "name": "review-requested" } },
      { "trigger": { "channel": "notification", "reason": "mention" },
        "output": { "eventType": "notification", "priority": 4, "name": "mention" } },
      { "trigger": { "channel": "notification", "reason": "security_alert" },
        "output": { "eventType": "alert", "priority": 7, "name": "security-alert" } }
    ],
    "default": { "eventType": "notification", "priority": 3 }
  }
  ```

### Codebase irregularities to ignore
- The story-stub Notes still reference `@octokit/webhooks-types@7.6.1`; the **resolved decision**
  is `@octokit/openapi-webhooks-types@^12.1.0`. Follow the Plan.
- The stub uses "source-discriminated"; the implementation uses `channel` (see AWE-153). Follow the Plan.

### Step-by-step tasks

#### CREATE `packages/github/` skeleton
- **IMPLEMENT**: package + tsconfig/tsup/vitest mirroring bootstrap; wire workspace deps.
- **GOTCHA**: `@octokit/openapi-webhooks-types` is a **devDependency** (types only) — it must not
  appear in the bundle; tsup externals workspace + runtime deps automatically.
- **VALIDATE**: `pnpm install && pnpm --filter @personal-events/github build`

#### CAPTURE exemplars
- **IMPLEMENT**: save real payloads for each covered event/reason into `exemplars/` (from the
  GitHub docs payload samples or a real delivery), plus `invalid-*.json` (wrong-typed fields).
- **GOTCHA**: keep them verbatim (do not hand-trim) so subset schemas are proven against real shapes.
- **VALIDATE**: `ls packages/github/exemplars | grep -c json` (≥ the covered set + invalids)

#### CREATE schemas (`notification.ts`, `webhook-payloads.ts`, `webhook-schema-registry.ts`)
- **IMPLEMENT**: the subset structs + registry; type-check each decoded result against the
  `@octokit/openapi-webhooks-types` type in a spec to confirm structural alignment.
- **VALIDATE**: `pnpm --filter @personal-events/github test webhook-payloads notification`

#### CREATE `github-trigger.ts` + `dot-safe.ts`
- **IMPLEMENT**: the trigger union + `toDotSafe`; unit-test `toDotSafe("github.com") === "github-com"`
  and that built triggers satisfy `NoDotString` where they feed `name`.
- **VALIDATE**: `pnpm --filter @personal-events/github test dot-safe`

#### CREATE `normalizer.ts`
- **IMPLEMENT**: `normalizeWebhook`, `normalizeNotification`, `githubToEvent`.
- **PATTERN**: the normalizer blocks above; compose with `integration-core.transform`.
- **GOTCHA**: produce a `name` that always satisfies `NoDotString`; omit `undefined` optional
  trigger fields so `matchKey` aligns with the JSON rule.
- **VALIDATE**: `pnpm --filter @personal-events/github test normalizer`

#### CREATE `github-mapping.json` + `mapping.ts`
- **IMPLEMENT**: the config data + `loadGithubConfig`; assert the JSON passes
  `integration-core.loadMappingConfig` (schema-valid) in a spec.
- **GOTCHA**: every rule's trigger `matchKey` must equal the `matchKey` the normalizer produces
  for that event/reason — add a spec that round-trips an exemplar through `githubToEvent` and
  asserts the resulting `eventType`/`priority`/`name`.
- **VALIDATE**: `pnpm --filter @personal-events/github test mapping`

#### CREATE `index.ts` + full suite
- **IMPLEMENT**: public exports; whole-package green.
- **VALIDATE**: `pnpm --filter @personal-events/github build && pnpm --filter @personal-events/github test`

### Testing strategy
- **Unit (exemplar-driven)**: every covered webhook event/action and notification reason
  classifies to the expected `eventType`/`priority`/`name`; an unknown event/reason → `default`;
  malformed `invalid-*.json` → typed `GithubNormalizeError` left; dotted values (`repo.full_name`
  containing `.`) never leak into `source`/`name`.
- **Integration**: none (pure package). End-to-end S3 writing is AWE-156/157.
- **Edge cases**: `push` (no `action`) trigger omits `action` and still matches its rule;
  notification with missing `subject` → typed failure; an event covered by a schema but absent
  from the mapping config → default (proves schema-coverage and mapping-coverage are independent).

### Validation commands
- Level 1: `pnpm --filter @personal-events/github exec biome check src`
- Level 2: `pnpm --filter @personal-events/github typecheck`
- Level 3: `pnpm --filter @personal-events/github test`
- Level 4: `pnpm build && pnpm test` (root — confirms integration-core ⇄ github wiring)
