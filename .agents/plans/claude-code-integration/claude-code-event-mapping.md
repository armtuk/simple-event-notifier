---
id: AWE-161
title: Claude Code event mapping (@personal-events/claude-code)
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
pm-record: recyDtzPYIHEqN2xN
pm-url: https://airtable.com/appnae8GXuj1rNVoQ/tblpJmL4dJ7Q4rw3U/recyDtzPYIHEqN2xN
branch: feature/claude-code-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-08-31
---

# Story: Claude Code event mapping (@personal-events/claude-code)

> **Restructured 2026-08-03, re-planned 2026-08-31.** Consumes `@personal-events/core` (AWE-153 — Core layer contracts) rather than the former `integration-core`, and is explicitly this feature's **Transformer + Service** per ADR `2026-08-03-0028-layered-architecture`.

## Definition

### User story
As the maintainer wiring Claude Code sessions into the event bus
I want a pure package that validates Claude Code hook payloads and classifies them into the
canonical event model via config
So that "prompt complete" and "the agent needs me" become correctly typed/prioritized events
with no transport or AWS concerns mixed in, reusing the same template GitHub and Slack use.

### Acceptance criteria

- **AC-01** — A new workspace package `@personal-events/claude-code` builds, lints, and tests under
  the monorepo toolchain and depends on **`@personal-events/core`** (AWE-153 — Core layer
  contracts) and `@personal-events/event-model` (AWE-150 — Shared event-model package). It is
  **pure**: no `@aws-sdk/*`, no `node:fs`, no network, no logging side effects.
- **AC-02** — **effect-`Schema` validators**, exemplar-driven from **real captured** Claude Code
  hook payloads, for the hook envelope and the consumed events — at minimum `Stop`,
  `Notification`, `SubagentStop`, `SessionStart`, `SessionEnd` — including the common fields
  (`session_id`, `transcript_path`, `cwd`, `hook_event_name`). A malformed payload yields a typed
  `Either` `Left` carrying a readable message; an **unknown `hook_event_name` is NOT rejected** —
  it decodes through a permissive catch-all member and reaches the default classification.
- **AC-03** — A **`claude-code` mapping config JSON**, schema-validated against `core`'s
  **`MappingConfigSchema`** — `{ integration, rules: Record<string, Output>, default: Output }`.
  Trigger keys are **plain strings** computed by the normalizer, with `Notification` subtypes
  distinguished by a **composite key** (`Notification:permission_prompt`,
  `Notification:idle_prompt`). There is **no rule ordering and no most-specific-first matching** —
  `core`'s `classify` is a single `Record` lookup falling back to `config.default`, and a `Record`
  has no order. The shipped rules are: `Notification:permission_prompt` → `alert` priority 6;
  `Notification:idle_prompt` → `alert` priority 5; `Stop` → `notification` priority 2 (so per-turn
  completions do not flood the bucket); `SubagentStop` → `notification` 2; `SessionStart` /
  `SessionEnd` → `notification` 1; **`default`** → `notification` priority 3.
- **AC-04** — A **pure normalizer** producing the `NormalizedEvent` shape `core` consumes: the
  composite **`trigger`** string, a human-readable `name` (`prompt-complete`, `agent-waiting`, …),
  the `source`, an **event identity for dedupe**, the project derived from `cwd`, and a transcript
  reference. It takes only the field slices it needs and performs no I/O.
- **AC-04a** — **Suppression and unknown-handling are distinct, and the sets are disjoint.** The
  package distinguishes two cases that must not be conflated:
  - a **suppressed** hook event — one on an explicit, documented `suppressedHookEvents` list (the
    high-frequency `PreToolUse` / `PostToolUse` / `UserPromptSubmit` family) — is **dropped by the
    normalizer** and never reaches `classify`;
  - an **unknown** `hook_event_name` — anything not consumed *and* not suppressed — is **emitted**,
    reaching `config.default` per AC-02 and AC-03.
  A hook event may appear in **exactly one** of: the consumed set, the suppression list, or
  neither (unknown). A test asserts the consumed set and the suppression list do not intersect.
- **AC-05** — Every `name` the package can emit satisfies event-model's `NoDotString`
  (`/^[^.]+$/`), **including the default kebab derivation for an unknown `hook_event_name`** — a
  hook event containing a dot must not produce an unparseable S3 key.
- **AC-06** — Changing an event's classification or priority is a **JSON edit only**, requiring no
  code change; the config schema rejects unknown shapes and out-of-range priorities.
- **AC-07** — Unit tests, driven by the exemplar files, cover: each consumed event decoding and
  mapping to its expected `eventType`/`priority`; an **unknown** event reaching `config.default`
  and being **emitted**; a **suppressed** event being **dropped**; a malformed payload producing a
  readable typed `Left`; and the normalizer's field extraction.
- **AC-08** — Guidance conformance: pure Gather→Compute with no Persist, module SRP, no enums
  (`as const` / `Schema.Literal`), `Record` lookups over `if`/`else if` chains, `Either` results,
  no accumulator loops, explicit return types. Verified by `biome` + `typecheck`.

### Notes / Open questions

- **Corrected 2026-08-31 after PR #3 review (Cursor Bugbot).** Two defects in the re-planned
  criteria are fixed above:
  1. **Unknown events were both dropped and classified.** AC-04 required the normalizer to drop
     "events outside the consumed set" while AC-02, AC-03 and AC-05 required those same unknown
     events to decode, reach the default and produce a kebab `name` — mutually unsatisfiable, so an
     implementer would have had to pick one and unknown hooks would either vanish or flood the
     bucket. **AC-04a** now separates an explicit **suppression list** (dropped by the normalizer)
     from **unknown** events (emitted via `config.default`), and requires the two sets to be
     disjoint.
  2. **The plan described a `core` contract that does not exist.** It referred to a
     `source`-discriminated trigger union, a trigger-union extension mechanism, and
     most-specific-first rule ordering. AWE-153 — Core layer contracts actually defines
     `rules: Schema.Record({ key: Schema.String, value: OutputSchema })` with a required `default`,
     resolved by a single `Record` lookup (`config.rules[normalized.trigger] ?? config.default`).
     Trigger keys are plain strings and a `Record` has no order, so subtypes are expressed as
     **composite keys** (`Notification:permission_prompt`). Written as it was, the config would not
     have loaded against the real schema.
- Confirm the exact Claude Code hook payload shapes by capturing real examples (the schemas are
  exemplar-driven); document where the exemplars came from.
- **Closed — `SessionStart`/`SessionEnd`/`SubagentStop` are consumed and emitted at low priority**
  (1 and 2 respectively) rather than suppressed. Suppression is reserved for the genuinely
  high-frequency `PreToolUse`/`PostToolUse`/`UserPromptSubmit` family, which fire many times per
  turn; the session-lifecycle events fire once each and are useful context.
- Decide the `name` derivation rule (stable, filename-safe, human-scannable in `aws s3 ls`).
- Event-identity for dedupe: confirm a stable id exists per hook delivery (session id +
  hook_event_name + a turn/sequence marker) so AWE-162 can dedupe reliably.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This package is
> **pure Gather→Compute** — schemas, a classification config, and a normalizer, with **zero I/O and
> zero transport/AWS code**. It is the Claude-specific **Transformer + Service** over `@personal-events/core`;
> keep all Claude specifics here and nothing provider-specific in `core`. Do not restate
> the user story.

### Decisions resolved during planning (open questions answered)
- **Consumed events + default classification** (config, all editable as JSON):

  | Trigger (`hook_event_name` [+ `notification_type`]) | `name` | `eventType` | `priority` |
  | --- | --- | --- | --- |
  | `Notification` + `permission_prompt` | `permission-needed` | `alert` | 6 |
  | `Notification` + `idle_prompt` | `agent-waiting` | `alert` | 5 |
  | `Notification` (other types: `auth_success`, `elicitation_*`) | `agent-notification` | `notification` | 2 |
  | `Stop` | `prompt-complete` | `notification` | 2 |
  | `SubagentStop` | `subagent-complete` | `notification` | 2 |
  | `SessionStart` | `session-start` | `notification` | 1 |
  | `SessionEnd` | `session-end` | `notification` | 1 |
  | _unmatched (default)_ | `<hook_event_name kebab>` | `notification` | 3 |

  Rationale: the README's two headline cases are "prompt complete" (`Stop` → low-noise
  notification) and "the LLM has a question" (`Notification`/`permission_prompt` → the strongest
  alert). `idle_prompt` is also "needs you" (alert, slightly lower). Everything else is low-priority
  info; nothing is dropped (default rule). Numbers are config — defer bikeshedding.
- **`name` derivation: a fixed, filename-safe, no-dot kebab string** per the table (event-model
  constrains `source`/`name` to `/^[^.]+$/`). The `name` is a stable label, NOT free text — this
  keeps S3 keys human-scannable (`…claude-code.permission-needed.json`).
- **Event-identity for dedupe**: there is **no delivery id** in the hook payload (confirmed via
  research). Compose a stable id from `session_id` + `hook_event_name` + `notification_type?` +
  `agent_id?`. This id is carried in the normalized output for AWE-162 to use; note that true
  cross-time replay dedupe is limited (the S3 key is timestamp-led) — the id is best-effort.
- **Trigger discrimination**: `core` has **no trigger union** — `rules` is a flat
  `Record<string, Output>`. The normalizer therefore computes a single `trigger` **string**:
  `hook_event_name` alone, or `` `${hook_event_name}:${notification_type}` `` when a
  `notification_type` is present. Composite keys keep Claude's triggers non-confusable with
  GitHub's (`event:action`) inside their own configs, without needing any schema extension.
- **Seam to `core` is read at execution time**: AWE-153 is a hard prerequisite and will
  exist when this runs. **Task 0 below reads `core`'s actual exported surface** and
  conforms the normalizer's output + the config shape to it, rather than guessing the stub's API.

### Acceptance evidence design

- **AC-02 (unknown event is not rejected)** — the criterion most likely to be implemented backwards.
  - *Defining input property*: a payload whose `hook_event_name` is genuinely **not** in the
    consumed set (e.g. `PreToolUse`), carrying otherwise-valid common fields.
  - *Direct assertions*: `decodeHookEvent` returns a `Right`, **not** a `Left`, and the value
    carries the raw `hook_event_name`.
  - *Evidence command*: `pnpm --filter @personal-events/claude-code test -- decode-unknown-event`
  - *Counterexample*: pair it with a genuinely malformed payload (missing `session_id`) asserting a
    `Left` — a schema that accepts everything would otherwise pass the unknown-event test trivially.
- **AC-03 (classification defaults)**
  - *Defining input property*: one real exemplar per row of the shipped table, including **both**
    `Notification` subtypes, since they classify to different priorities.
  - *Direct assertions*: each exemplar resolves to exactly the documented `eventType` and
    `priority`; the table test enumerates every shipped rule and fails if a rule is added without a
    case.
  - *Evidence command*: `pnpm --filter @personal-events/claude-code test -- classification-table`
- **AC-05 (no-dot invariant on every emitted name)** — the subtle one.
  - *Defining input property*: an unknown `hook_event_name` that **contains a dot** (e.g.
    `Custom.Thing`), exercising the default kebab derivation rather than the fixed table values.
  - *Direct assertions*: the derived `name` matches `/^[^.]+$/` and is accepted by event-model's
    `NoDotString` schema.
  - *Evidence command*: `pnpm --filter @personal-events/claude-code test -- name-no-dot`
  - *Counterexample*: the fixed table values trivially satisfy this; only the derived-default path
    can violate it, so a test that checks only the table proves nothing.
- **AC-01 (purity)**
  - *Evidence command*:
    `! rg -n '@aws-sdk|node:fs|node:net|fetch\(' packages/claude-code/src`
  - *Direct assertions*: no I/O import of any kind in the package source.
- **AC-06 (config-only change)**
  - *Defining input property*: a modified copy of the config JSON with one rule's priority changed.
  - *Direct assertions*: classification changes accordingly with **no** source edit; a tampered
    config with priority `9` is rejected by the schema.
  - *Evidence command*: `pnpm --filter @personal-events/claude-code test -- config-schema`
- **Complete-set inventory (AC-07 says *each* consumed event)**: the consumed set is exactly
  `Stop`, `Notification` (× `permission_prompt`, `idle_prompt`, other), `SubagentStop`,
  `SessionStart`, `SessionEnd` — **7 cases**, one exemplar file each, enumerated by an `it.each`
  over the `exemplars/` directory listing so a missing exemplar fails rather than silently
  shrinking coverage.

**No production write, and no live integration, is required by this story.** The package is pure —
its only inputs are captured exemplar files. The end-to-end S3 path is exercised by AWE-162 —
Publishable hook CLI. Exemplar capture is a **local** activity against the developer's own Claude
Code session, not a third-party API call.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md, typescript.md, effect/index.md. -->
- **Gather / Compute, no Persist** (`general.md`): pure validation + classification + field
  extraction. No S3, no network, no fs, no logging side effects.
- **Module-level SRP** (`general.md`): `hook-events.ts` (payload schemas + the discriminated union),
  `notification-types.ts` (the `notification_type` `as const` set), `decode.ts` (the boundary
  `decodeHookEvent` returning `Either`), `normalize.ts` (the pure normalizer), `config-schema.ts`
  `claude-code.config.json` (the rules data), `index.ts` (re-exports).
- **Slice, don't dump** (`general.md`): the normalizer and any helper take the specific fields they
  need (e.g. a `Notification` payload's `notification_type`), not the whole envelope, except the
  top-level decode which necessarily takes the whole `unknown`.
- **No enums** (`typescript.md`): `notification_type` values, `hook_event_name` values, and the
  `name` labels are `as const` objects / `Schema.Literal` unions.
- **Branch selection via `Record`** (`typescript.md`): the `hook_event_name → name` derivation and
  the notification-subtype split are `Record` lookups, not `if/else if` chains.
- **Return Values** (`typescript.md`): `decodeHookEvent(raw): Either<ClaudeHookEvent, string>`
  (effect `Either`); no throwing across the package boundary.
- **No accumulator loops** (`typescript.md`): config rule resolution is a `find`/`Record` lookup,
  not a hand-rolled loop with a mutable match variable.
- **TS house style**: no semicolons, double quotes, width 140, arrow functions, `.ts` imports.

### Files to read — READ THESE BEFORE IMPLEMENTING
- **`@personal-events/core` actual exports** (the built AWE-153 package — `packages/core/src/index.ts`:
  `Transformer<Raw>`, `classify`, `NormalizedEvent`, `MappingConfigSchema`, the typed error classes)
  — Why: the
  exact contract this package must conform to: `MappingConfigSchema` (`integration` / `rules`
  `Record` / required `default`), `NormalizedEvent`, and `classify`'s single-lookup semantics. This
  is the single most important read; AWE-153's
  `.agents/plans/minimal-event-pipeline/core-layer-contracts.md` Definition is the spec, the built
  code is the truth. **Note:** AWE-153 moved out of `github-integration` into
  `minimal-event-pipeline` on 2026-08-03 and was re-scoped to `@personal-events/core`; the
  `SourceAdapter`/`SecondaryProcessor`/`transform` names above are stale — it now exports
  `Transformer<Raw>`, `classify`, `NormalizedEvent` and the `EventRepository` tag.
- `.agents/plans/minimal-event-pipeline/event-model-package.md` (AWE-150) — Why: the `Event` shape, the no-dot
  `source`/`name` constraint (the `name` labels must satisfy `/^[^.]+$/`), and priority 1–8.
- `.agents/frameworks/effect/effect.md` and `.agents/cache/effect/v3/_main/schema.md` — Why:
  `Schema.Struct`, `Schema.Literal`, `Schema.Union` discriminated unions, `Schema.decodeUnknownEither`,
  `TreeFormatter.formatErrorSync`, `optionalWith`.
- `.agents/tests.md` and `.agents/languages/typescript/typescript-testing.md` — Why: the
  **`exemplars/` directory of real captured hook payloads** drives the spec tables (happy + sad).
- `.agents/languages/typescript/typescript.md` (Enums, Branch Selection, Return Values) — Why: the
  literal-union/`Record`/`Either` rules.
- `.agents/plans/github-integration/github-event-mapping.md` *if it has been planned by then* — Why:
  the sibling instance of the same template; mirror its package structure so Claude/GitHub/Slack
  mappings are consistent. (May still be a stub — mirror the shape regardless.)

### Files to create / change
- `packages/claude-code/package.json` — `@personal-events/claude-code`, `private: true`,
  `type: module`; `dependencies`: `effect`, `@personal-events/event-model`,
  `@personal-events/core` (`workspace:*`); `devDependencies`: `tsup`, `vitest`,
  `typescript`; scripts.
- `packages/claude-code/tsconfig.json` — extends base, `composite: true`. Set
  `resolveJsonModule: true` (to import the config JSON) if not already in the base.
- `packages/claude-code/tsup.config.ts` — esm, node24, `dts: true`; ensure the config JSON is
  emitted/copied (either `import` it so it is bundled into the entry, or add an asset copy rule).
- `packages/claude-code/vitest.config.ts` — `defineProject` `name: "claude-code"`.
- `packages/claude-code/src/notification-types.ts` — `notificationTypes` `as const` +
  `NotificationType` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
  `elicitation_complete`, `elicitation_response`).
- `packages/claude-code/src/hook-events.ts` — common-field schemas + `StopEvent`,
  `NotificationEvent`, `SubagentStopEvent`, `SessionStartEvent`, `SessionEndEvent`, and
  `ClaudeHookEvent = Schema.Union(...)` discriminated on `hook_event_name`.
- `packages/claude-code/src/decode.ts` — `decodeHookEvent(raw: unknown): Either<ClaudeHookEvent, string>`
  via `Schema.decodeUnknownEither(ClaudeHookEvent, { errors: "all" })` + `TreeFormatter`.
- `packages/claude-code/src/normalize.ts` — the pure normalizer → the input shape
  `core's `classify`` consumes (trigger key + `name` + `source` + `eventId` + project +
  raw payload).
- `packages/claude-code/src/config-schema.ts` — a typed loader for the config JSON, validating it
  against `core`'s `MappingConfigSchema`. **No trigger-variant declaration is needed** — `core`
  keys `rules` by plain string.
- `packages/claude-code/src/suppressed.ts` — the explicit `suppressedHookEvents` `as const` list
  behind AC-04a, plus the assertion helper proving it is disjoint from the consumed set.
- `packages/claude-code/claude-code.config.json` — the rules table above as data.
- `packages/claude-code/src/index.ts` — public re-exports (schemas, `decodeHookEvent`, `normalize`,
  the loaded config).
- `packages/claude-code/exemplars/` — real captured payloads: `valid-stop.json`,
  `valid-notification-permission.json`, `valid-notification-idle.json`, `valid-subagent-stop.json`,
  `valid-session-start.json`, `valid-session-end.json`, and `invalid-missing-session-id.json`,
  `invalid-bad-shape.json`.
- specs: `decode.spec.ts`, `normalize.spec.ts`, `config-schema.spec.ts`.

### Relevant documentation
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) — Why: the authoritative
  per-event payload field list (the schemas mirror it).
- [effect Schema basic usage](https://effect.website/docs/schema/basic-usage/) — Why: `Struct`,
  `Literal` unions, `Union` discriminated unions, `optionalWith`.
- [effect Schema getting started — decoding](https://effect.website/docs/schema/getting-started/)
  — Why: `Schema.decodeUnknownEither(schema, { errors: "all" })` returning `Either<A, ParseError>`.
- [effect Schema error formatters](https://effect.website/docs/schema/error-formatters/) — Why:
  `TreeFormatter.formatErrorSync` for the readable `Left` string.

### Patterns to follow
- **Common envelope + per-event structs, unioned on `hook_event_name`:**
  ```ts
  import { Schema } from "effect"
  const HookCommon = {
    session_id: Schema.String,
    transcript_path: Schema.String,
    cwd: Schema.String,
    permission_mode: Schema.optionalWith(Schema.String, { exact: true }),
  }
  const StopEvent = Schema.Struct({ ...HookCommon, hook_event_name: Schema.Literal("Stop"), stop_hook_active: Schema.Boolean })
  const NotificationEvent = Schema.Struct({ ...HookCommon, hook_event_name: Schema.Literal("Notification"), notification_type: NotificationTypeSchema, message: Schema.String })
  // …SubagentStop (agent_id, agent_type), SessionStart (source, model, session_title?), SessionEnd (reason)…
  export const ClaudeHookEvent = Schema.Union(StopEvent, NotificationEvent, SubagentStopEvent, SessionStartEvent, SessionEndEvent)
  export type ClaudeHookEvent = typeof ClaudeHookEvent.Type
  ```
- **Decode at the boundary returns `Either`:**
  ```ts
  import { Either, Schema } from "effect"
  import { TreeFormatter } from "effect/ParseResult"
  export const decodeHookEvent = (raw: unknown): Either.Either<ClaudeHookEvent, string> =>
    Either.mapLeft(Schema.decodeUnknownEither(ClaudeHookEvent, { errors: "all" })(raw), (e) => TreeFormatter.formatErrorSync(e))
  ```
- **`name` derivation via `Record`** keyed by `hook_event_name`, with the `Notification` case
  a **composite trigger string** (`` `${hook_event_name}:${notification_type}` `` when a subtype is
  present, otherwise `hook_event_name`) used directly as the `rules` key, plus a `Record`-keyed
  `name` derivation with a default that kebabs the raw `hook_event_name`. No `if/else if` chains,
  and **no ordered rule list** — `core` resolves by `Record` lookup.
- **Exemplar capture (how to get real data):** temporarily wire a hook
  `"command": "cat > /tmp/claude-hooks/$(date +%s%N).json"` (or `tee`) for `Stop`/`Notification`/etc
  in a scratch `settings.json`, drive a real Claude Code session to fire each event, and copy the
  captured JSON into `exemplars/`. Document the capture method in a short `exemplars/README.md`.

### Codebase irregularities to ignore
- **Bundler: use `tsup`.** An earlier version of this plan said tsdown, citing AWE-160 — Shared S3
  event writer. That story is `todo:abandoned`, and `CLAUDE.md`'s binding stack table specifies
  **tsup**, as does every `ready` sibling story. `node/preferences.md` mentions tsdown but is
  superseded here by the project's own `CLAUDE.md`.
- Effect Schema is in **`effect`** (not `@effect/schema`). Use `Schema.decodeUnknownEither`
  (current v3); ignore effect v4-beta API names (`decodeUnknownExit`, `TaggedUnion`).
- `Notification` **does** support a `matcher` on `notification_type` in settings.json (used by
  AWE-162's recipe), but matching here in the mapping is by the config rules, not the hook matcher.

### Step-by-step tasks
Execute in order.

#### READ `@personal-events/core`'s actual surface (Task 0 — no code)
- **IMPLEMENT**: open the built `@personal-events/core` exports; record the exact mapping-config
  schema (`integration`, `rules: Record<string, Output>`, required `default`), `NormalizedEvent`'s
  fields — in particular `trigger` — and `classify`'s single-`Record`-lookup semantics. Conform
  every shape below to it. If it diverges materially from the AWE-153 Definition, note it and adapt.
- **VALIDATE**: write down (in the PR description) the `core` types this package targets:
  `Transformer<Raw>`, `classify`, `NormalizedEvent`, `MappingConfigSchema`.

#### CREATE packages/claude-code scaffold
- **IMPLEMENT**: `package.json`/`tsconfig`/`tsup.config`/`vitest.config`; `resolveJsonModule`.
- **PATTERN**: mirror a built sibling package — `packages/event-model` (AWE-150) or
  `packages/core` (AWE-153). **Not** AWE-160, which is abandoned and was never built.
- **GOTCHA**: ensure the config JSON ships in the build output (import it into the entry so tsup
  bundles it, or add an asset copy step).
- **VALIDATE**: `pnpm --filter @personal-events/claude-code build`.

#### CAPTURE exemplars + CREATE schemas (hook-events.ts, notification-types.ts, decode.ts)
- **IMPLEMENT**: capture real payloads into `exemplars/`; author the literal-union schemas + the
  discriminated `ClaudeHookEvent` union + `decodeHookEvent`.
- **PATTERN**: the envelope/union/decode snippets above; field list from the hooks reference.
- **GOTCHA**: an **unknown `hook_event_name`** must NOT fail decode hard — model the union to accept
  known events, and let unknown events fall to the normalizer's default path (decode a permissive
  "other" variant carrying the common fields + raw, rather than rejecting). Confirm the exact
  approach once the schemas are drafted (a trailing `Schema.Struct({ ...HookCommon, hook_event_name:
  Schema.String })` catch-all member, ordered last).
- **VALIDATE**: `pnpm --filter @personal-events/claude-code typecheck`.

#### CREATE the config (claude-code.config.json + config-schema.ts) and normalizer (normalize.ts)
- **IMPLEMENT**: the rules table as JSON validated by `core`'s mapping-config schema (+ the Claude
  trigger variant); the pure `normalize` producing transform inputs (trigger key, `name`, `source`,
  `eventId`, project from `basename(cwd)`, transcript ref + raw in payload), dropping non-consumed
  events.
- **PATTERN**: `Record`-lookup name derivation; `eventId = [session_id, hook_event_name,
  notification_type, agent_id].filter(Boolean).join(":")`.
- **GOTCHA**: `name` must satisfy event-model's `/^[^.]+$/` (no dots) — the table values already do;
  the default-kebab must strip/replace any dots.
- **VALIDATE**: `pnpm --filter @personal-events/claude-code typecheck`.

#### CREATE specs (exemplar-driven)
- **IMPLEMENT**: `decode.spec.ts` (each valid exemplar decodes; each invalid exemplar yields a
  readable `Left`); `normalize.spec.ts` (each event → expected `name`/`eventId`/dropped); 
  `config-schema.spec.ts` (config validates; an unmapped trigger resolves to the default; an
  out-of-range priority in a tampered config is rejected).
- **PATTERN**: `.agents/tests.md` exemplars; `it.each` over the exemplar files.
- **VALIDATE**: `pnpm --filter @personal-events/claude-code test`.

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: pass against `general.md` + `typescript.md`: module SRP; pure (no I/O); `Record`
  lookups (no if/else chains); `as const`/literals (no enums); `Either` results; no accumulator
  loops; explicit return types; arrow functions.
- **VALIDATE**: `pnpm --filter @personal-events/claude-code exec biome check src` + `typecheck`
  clean; optionally `/simplify`.

### Testing strategy
- **Unit (exemplar-driven, no mocks needed — pure)**: valid decode for each consumed event; readable
  typed `Left` for malformed payloads; unknown `hook_event_name` → default classification (not a
  hard failure); normalizer field extraction + noise filtering; config validation + default
  fallback + out-of-range-priority rejection.
- **Integration**: n/a (pure package; the end-to-end path is exercised in AWE-162).
- **Edge cases**: `Notification` with each `notification_type`; `SubagentStop` carrying
  `agent_id`/`agent_type`; `SessionStart` with each `source`; a payload missing a required common
  field; an event type outside the consumed set (must be dropped by the normalizer, not crash).

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @personal-events/claude-code exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/claude-code typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/claude-code test`
- Level 4 — Consume check: confirm AWE-162 can
  `import { decodeHookEvent, normalize, claudeCodeConfig } from "@personal-events/claude-code"`
  and that `normalize`'s output type matches `core's `classify``'s expected input.
