---
id: AWE-153
title: Core layer contracts (@personal-events/core)
type: story
status: todo:backlog
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-03
---

# Story: Core layer contracts (@personal-events/core)

> **Restructured 2026-08-03.** Re-scoped from *Reusable integration template (`integration-core`)* and moved out of `github-integration` — it was never GitHub-specific, and its placement there transitively blocked every other integration. It now owns the `Repository` / `Service` / `Transformer` contracts from ADR `2026-08-03-0028-layered-architecture`, plus the mapping-config schema and typed errors. **Dropped:** `SourceAdapter` and `SecondaryProcessor` (no implementations, deferred execution model) and the `channel` discriminant with its compile step, which existed to reconcile GitHub's two API namespaces — AWE-157 was abandoned, leaving one channel. **The `## Plan` below predates this and is partly stale — re-run `/plan-story` before executing.**

## Definition

### User story
As the developer adding event sources to personal-events
I want a reusable integration template that turns a raw provider event into a canonical event
using a declarative mapping config
So that each new integration (GitHub first, then Slack, agents, …) is a config + a normalizer,
not a fresh pile of bespoke classification code.

### Acceptance criteria
- A `@personal-events/integration-core` package exports a **mapping-config schema** (effect
  Schema) describing, per integration, a list of rules where each rule has a
  **`source`-discriminated trigger** (a `source` tag plus provider-specific match fields — so a
  webhook `event`+`action` and a notification `reason` are distinct, non-confusable shapes) and
  an `output: { eventType: "alert" | "notification", priority: 1–8, secondaryProcessing?: string[] }`,
  plus a documented **default** for unmatched triggers (so nothing is silently dropped). The
  discriminant set is open/extensible so future integrations add their own source variants.
- A **pure** `transform(config, rawProviderEvent) → Event` (or `Either<Event, error>`) that
  produces a canonical `@personal-events/event-model` `Event`, applying the mapping for
  classification/priority and carrying the raw payload through.
- Adapter **interfaces** only (no concrete impls here): `SourceAdapter` (something that yields
  raw provider events — a webhook handler or a poller both satisfy it) and `SecondaryProcessor`
  (a named hook the transform can declare; **interface defined, no processors implemented**).
- A config **loader/validator** that reads a JSON mapping config and fails typed on an invalid
  shape.
- Unit tests: valid/invalid config parsing, classification via the map, default fallback for an
  unmapped name, priority pass-through, and that an unknown `secondaryProcessing` name is
  reported rather than silently ignored.
- **Failure modes:** malformed config, an event-name absent from the map (→ default), and an
  out-of-range priority in config each produce a clear typed failure or documented fallback.

### Notes / Open questions
- This is the "template for each integration" the user described; keep it provider-agnostic —
  no GitHub specifics leak in here.
- Open: should the config also map to a `name` transform, or is `name` taken verbatim from the
  provider event-name? (Decide in `/plan-story`.)
- Open: secondary-processing execution model (sync inline vs enqueued) — only the **interface**
  is in scope now; execution is a later feature.
- Depends on `event-model` (AWE-150, feature `bootstrap-and-iac`) for the canonical `Event`.

> **Resolved in planning (2026-06-29):**
> - **`name` is config-driven with a normalizer fallback.** A rule's `output` carries an
>   **optional** `name: NoDotString` label (e.g. `new-pull-request`); `transform` uses
>   `output.name ?? normalized.name`. This answers both this story's open question *and*
>   AWE-154's "per-event human-readable label in the mapping config" question. The framework
>   never derives a name from raw provider data — that is the normalizer's job (AWE-154).
> - **Trigger discriminant is named `channel`, not `source`.** The spec calls it the "source
>   tag", but `source` is already the canonical provider identity on `Event` (`github`). To
>   avoid one object carrying two different "source" meanings, the discriminant field is
>   `channel` (values like `webhook` / `notification` / `events_api`). Applied consistently in
>   AWE-154. **If you prefer the literal `source` name, say so and I will rename across both.**
> - **`transform` takes a `NormalizedEvent`, not the literal raw provider event.** The
>   normalizer (AWE-154) is what knows GitHub's wire shapes; it produces a provider-agnostic
>   `NormalizedEvent` (canonical `source`/`name`/`timestamp` + a `channel`-discriminated
>   `trigger` + the raw `payload`) and hands that to `transform`. This keeps `integration-core`
>   free of any provider knowledge while still owning all classification.
> - **Config is compiled once.** A pure `compileMappingConfig(config) → CompiledConfig`
>   pre-builds a `ReadonlyMap<string, Output>` keyed by a canonical trigger match-key, so
>   `transform` is an O(1) lookup per event rather than a per-event scan — and the rule-list →
>   map build is not an accumulator loop (it is `new Map(rules.map(...))`).

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This is the
> **first code** in a greenfield repo: nothing under `packages/` exists yet. The whole story
> depends on `bootstrap-and-iac` (AWE-149 monorepo + AWE-150 `event-model`) having landed — do
> not start until `packages/event-model` builds and `pnpm install && pnpm build` is green.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
Extracted from `.agents/general.md`, `.agents/languages/typescript/*`, `.agents/frameworks/effect/index.md`. Each is a hard requirement:

- **Gather / Compute / Persist**: this package is **pure Compute only** — no I/O in `transform`,
  `compileMappingConfig`, `matchKey`, or the schemas. The single Gather touchpoint is
  `readConfigFile(path)` (reads a JSON file → `unknown`); keep it in its own module, separate
  from the pure validator `loadMappingConfig(raw, opts)`. There is no Persist phase here (the
  S3 write lives in AWE-155).
- **Module-level SRP** (`general.md` §"Separation applies at the module/file level"): one reason
  to change per file — separate schemas, the compiler, the transform, the loader, the file
  reader, and each interface into their own modules even though several have one consumer today.
- **Slice, don't dump**: `transform` receives a `NormalizedEvent` (a tailored slice), not an
  open provider blob; helper functions receive only the fields they use.
- **No accumulator loops** (`typescript.md` §Looping): build the rule lookup with
  `new Map(config.rules.map(r => [matchKey(r.trigger), r.output]))`, never a `for` filling a
  `Map`. Read `.agents/code-examples/typescript/src/looping.ts` before writing any iteration.
- **No enums** (`typescript.md` §Enums): `eventType`/`channel` are `Schema.Literal(...)` unions
  and, where a runtime list is needed, `as const` objects with `typeof x[keyof typeof x]`.
- **No if/else chains on one discriminator** (`typescript.md` §Branch Selection): rule selection
  is a `Map`/`Record` lookup with an explicit default, not branching.
- **Result/error types** (`typescript.md` §Return Values): every fallible boundary returns
  `Either<A, E>` with a `Schema.TaggedError` on the left — never a bare throw, never
  `Promise<null|undefined>`. Mirrors `event-model`'s `parseEvent: (raw) => Either<Event, string>`.
- **TS style**: no trailing semicolons, double quotes, `lineWidth: 140`, arrow functions with
  explicit return types, `.ts` relative-import extensions (`rewriteRelativeImportExtensions` is
  on), `camelCase`, public members, `noExplicitAny: error`.
- **Effect Schema** is the validation tool (not zod) since this is an Effect project. Import
  `{ Schema, Either, ParseResult }` from `"effect"` (the `effect@^3.21` barrel — `@effect/schema`
  is deprecated/merged). Read `.agents/frameworks/effect/v3/_main/schema.md` for the exact API.
- **ADR**: `integration-core` is a *new architectural element* (the reusable integration
  template). Per `.agents/general.md` and `.agents/guidance/adr.md`, author an ADR for the
  template + dual-path design. **One ADR covers the whole feature** — author it here (the first
  story) and reference it from AWE-155/156/157 rather than one per story.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/bootstrap-and-iac/event-model-package.md` — Why: the load-bearing `Event`
  contract this package consumes. Note exact exports (`EventSchema`, `Event`, `buildKey`,
  `parseKey`, `parseEvent`), the field schemas (`IsoInstant`, `Priority = Schema.Int.pipe(Schema.between(1,8))`,
  `NoDotString = Schema.NonEmptyString.pipe(Schema.pattern(/^[^.]+$/))`), and that `parseEvent`
  returns `Either<Event, string>`.
- `.agents/plans/bootstrap-and-iac/monorepo-bootstrap.md` — Why: the exact package skeleton to
  mirror (`tsconfig.json` extends base + `composite: true`; tsup `entry: ["src/index.ts"]`,
  `format: ["esm"]`, `target: "node24"`, `dts: true`; vitest `defineProject` with a unique
  `name`; biome `asNeeded` semicolons / double quotes / width 140).
- `.agents/frameworks/effect/v3/_main/schema.md` — Why: `Schema.Struct`, `Schema.Literal`,
  `Schema.Union`, `Schema.Record`, `Schema.Array`, `Schema.optional`, `Schema.between`,
  `Schema.decodeUnknownEither`, `Schema.TaggedError`, `typeof X.Type`.
- `.agents/languages/typescript/typescript.md` §Looping, §Branch Selection, §Return Values, §Enums
  and `.agents/code-examples/typescript/src/looping.ts` — Why: the banned-loop canon.
- `.agents/guidance/adr.md` — Why: the three-file ADR layout under `docs/decisions/{yyyy-mm-dd-HHMM}-{slug}/`.

### Files to create / change
- `packages/integration-core/package.json` — name `@personal-events/integration-core`, private,
  `type: module`, deps `effect`, `@personal-events/event-model` (`workspace:*`); dev `tsup`,
  `vitest`, `typescript`, `@biomejs/biome`; scripts `build`/`typecheck`/`lint`/`test` per the bootstrap pattern.
- `packages/integration-core/tsconfig.json` — extends root base, `composite: true`.
- `packages/integration-core/tsup.config.ts` — mirror the bootstrap tsup shape.
- `packages/integration-core/vitest.config.ts` — `defineProject({ test: { name: "integration-core" } })`.
- `packages/integration-core/src/channel.ts` — `TriggerSchema`, `matchKey(trigger): string` (pure).
- `packages/integration-core/src/mapping-config.ts` — `OutputSchema`, `MappingRuleSchema`,
  `MappingConfigSchema`, and derived types (`MappingConfig`, `Output`, `Trigger`).
- `packages/integration-core/src/normalized-event.ts` — `NormalizedEventSchema`, `NormalizedEvent` type.
- `packages/integration-core/src/compile.ts` — `CompiledConfig`, `compileMappingConfig(config): CompiledConfig`.
- `packages/integration-core/src/transform.ts` — `transform(compiled) => (normalized) => Either<Event, TransformError>`.
- `packages/integration-core/src/loader.ts` — `loadMappingConfig(raw, { knownProcessors }): Either<CompiledConfig, ConfigError>`.
- `packages/integration-core/src/config-file.ts` — `readConfigFile(path): Promise<...>` (the only I/O; Gather).
- `packages/integration-core/src/source-adapter.ts` — `SourceAdapter` interface (no impl).
- `packages/integration-core/src/secondary-processor.ts` — `SecondaryProcessor` interface (no impl).
- `packages/integration-core/src/errors.ts` — `ConfigParseError`, `UnknownProcessorError`,
  `TransformError` (`Schema.TaggedError`).
- `packages/integration-core/src/index.ts` — public re-exports.
- Co-located specs: `channel.spec.ts`, `mapping-config.spec.ts`, `compile.spec.ts`,
  `transform.spec.ts`, `loader.spec.ts`.
- `packages/integration-core/exemplars/valid-config-*.json`, `invalid-config-*.json`.
- `docs/decisions/{yyyy-mm-dd-HHMM}-integration-template-and-dual-path/{adr-body.md,adr-revision-log.md,adr-state-changes.md}`
  + add the row to the repo `README.md` ADR index.

### Patterns to follow
- **Schemas mirror `event-model`'s style** — `as const`-free `Schema.Literal` unions, reusable
  field schemas, `export type X = typeof XSchema.Type`, `/*#__PURE__*/` annotation on exported
  schema consts (effect tree-shaking, per the event-model note).
- **Channel-discriminated trigger** (`src/channel.ts`):
  ```ts
  // a channel tag + provider-specific string match-fields (open index signature)
  export const TriggerSchema = Schema.Struct(
    { channel: Schema.NonEmptyString },
    Schema.Record({ key: Schema.String, value: Schema.String })
  )
  export type Trigger = typeof TriggerSchema.Type
  // canonical, order-independent key so config rule ⇄ incoming event compare identically
  export const matchKey = (trigger: Trigger): string => {
    const { channel, ...match } = trigger
    const fields = Object.entries(match).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join("&")
    return `${channel}:${fields}`
  }
  ```
  The framework stores triggers as `channel`-tagged string-records; the *non-confusable
  discriminated union* (webhook vs notification shapes) is enforced by the GitHub trigger schema
  in AWE-154, which refines this open shape.
- **Output + config schema** (`src/mapping-config.ts`):
  ```ts
  import { Priority } from "@personal-events/event-model"   // see GOTCHA — may need export
  export const OutputSchema = Schema.Struct({
    eventType: Schema.Literal("alert", "notification"),
    priority: Priority,                                     // Schema.Int.pipe(Schema.between(1,8))
    name: Schema.optional(NoDotString),                    // config-driven name label (optional)
    secondaryProcessing: Schema.optional(Schema.Array(Schema.NonEmptyString))
  })
  export const MappingRuleSchema = Schema.Struct({ trigger: TriggerSchema, output: OutputSchema })
  export const MappingConfigSchema = Schema.Struct({
    integration: Schema.NonEmptyString,
    rules: Schema.Array(MappingRuleSchema),
    default: OutputSchema                                   // documented fallback — nothing dropped
  })
  ```
- **Compile then transform** (`src/compile.ts`, `src/transform.ts`):
  ```ts
  export interface CompiledConfig { lookup: ReadonlyMap<string, Output>; fallback: Output; integration: string }
  export const compileMappingConfig = (config: MappingConfig): CompiledConfig => ({
    integration: config.integration,
    fallback: config.default,
    lookup: new Map(config.rules.map(r => [matchKey(r.trigger), r.output]))   // NOT a loop
  })
  // curried: config-first HOF (general.md §Higher order Functions)
  export const transform = (compiled: CompiledConfig) =>
    (normalized: NormalizedEvent): Either.Either<Event, TransformError> => {
      const output = compiled.lookup.get(matchKey(normalized.trigger)) ?? compiled.fallback
      const candidate = {
        schemaVersion: 1, timestamp: normalized.timestamp,
        eventType: output.eventType, priority: output.priority,
        source: normalized.source, name: output.name ?? normalized.name,
        acknowledged: false, handled: false, payload: normalized.payload
      }
      return pipe(parseEvent(candidate), Either.mapLeft(msg => new TransformError({ reason: msg })))
    }
  ```
- **Loader validates + reports unknown processors** (`src/loader.ts`): decode with
  `Schema.decodeUnknownEither(MappingConfigSchema, { errors: "all" })`; then collect every
  `rule.output.secondaryProcessing` name (`rules.flatMap(r => r.output.secondaryProcessing ?? [])`)
  and `filter` those **not** in `knownProcessors` — a non-empty result becomes a
  `UnknownProcessorError`; otherwise `compileMappingConfig`. All via `Either` chaining
  (`Either.flatMap`), no throws.
- **Errors** (`src/errors.ts`): `class TransformError extends Schema.TaggedError<TransformError>()("TransformError", { reason: Schema.String }) {}` and likewise `ConfigParseError`, `UnknownProcessorError` (carry the offending names).
- **Logging**: this pure package emits **no logs** (logging is a Persist/edge concern in
  AWE-155/156/157). Surface failures as typed `Either` lefts for the caller to log per
  `.agents/guidance/logging.md`.

### Codebase irregularities to ignore
- `.agents/object-types-typescript.md` is **NestJS-flavored** (constructor DI, `*.service.ts`,
  `*.repository.ts`). This package has **no NestJS and no datastore** — apply the *spirit*
  (transformers between boundary shapes; SRP) but not the DI/Nest mechanics. The Repository
  pattern becomes relevant only where real I/O appears (S3 in AWE-155, GitHub API in AWE-157).
- The story-stub Definition still uses the word "source" for the trigger discriminant; the Plan
  renames it `channel` (see Notes). Follow the Plan.

### Step-by-step tasks
Execute in order, top to bottom.

#### CREATE `packages/integration-core/` package skeleton
- **IMPLEMENT**: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` mirroring
  the bootstrap conventions; add to the pnpm workspace (already globbed by `packages/*`).
- **PATTERN**: `.agents/plans/bootstrap-and-iac/monorepo-bootstrap.md` (tsup/vitest/tsconfig shapes).
- **IMPORTS**: deps `effect@^3.21`, `@personal-events/event-model@workspace:*`.
- **GOTCHA**: `composite: true` + `dts: true` or downstream packages (AWE-154) can't consume types.
- **VALIDATE**: `pnpm install && pnpm --filter @personal-events/integration-core build`

#### CREATE `src/channel.ts` (TriggerSchema + matchKey)
- **IMPLEMENT**: open `channel`-tagged record trigger schema and the pure `matchKey`.
- **PATTERN**: the channel block above.
- **GOTCHA**: `matchKey` must be **order-independent** (sort entries) so a config rule and a
  runtime trigger with the same fields in different key order collide to the same key.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core test channel`

#### CREATE `src/mapping-config.ts` + `src/normalized-event.ts`
- **IMPLEMENT**: `OutputSchema`/`MappingRuleSchema`/`MappingConfigSchema` and
  `NormalizedEventSchema` (`source: NoDotString`, `name: NoDotString`, `timestamp: IsoInstant`,
  `trigger: TriggerSchema`, `payload: Schema.Record({key: Schema.String, value: Schema.Unknown})`).
- **PATTERN**: reuse `event-model` field schemas via import.
- **GOTCHA — `Priority`/`NoDotString`/`IsoInstant` reuse**: `event-model`'s public exports list
  is `EventSchema`/`Event`/`buildKey`/`parseKey`/`parseEvent` — the field schemas may **not** be
  exported yet. **Preferred**: have AWE-150 export `Priority`, `NoDotString`, `IsoInstant` and
  import them (single source of truth for the 1–8 bound and the no-dot rule). If they are not
  exported, this is a forward-dependency on AWE-150 — surface it, do **not** silently re-declare
  the bounds here (that would fork the contract). See Feature-dependency note below.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core typecheck`

#### CREATE `src/errors.ts`, `src/compile.ts`, `src/transform.ts`
- **IMPLEMENT**: the three tagged errors; `compileMappingConfig`; curried `transform`.
- **PATTERN**: the compile/transform block above.
- **IMPORTS**: `{ Schema, Either, pipe }` from `"effect"`; `parseEvent`, `type Event` from `@personal-events/event-model`.
- **GOTCHA**: `transform` builds a plain candidate object and re-validates it through
  `parseEvent` so an out-of-range/dotted value from config is caught as a typed `Left`, not a
  silently-bad event.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core test transform`

#### CREATE `src/loader.ts` + `src/config-file.ts`
- **IMPLEMENT**: pure `loadMappingConfig(raw, { knownProcessors })`; separate `readConfigFile` I/O.
- **PATTERN**: `Either` chaining; unknown-processor `filter` described above.
- **GOTCHA**: keep `readConfigFile` (Gather/I/O) out of `loader.ts` (pure Compute) — module SRP.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core test loader`

#### CREATE `src/source-adapter.ts` + `src/secondary-processor.ts` (interfaces only)
- **IMPLEMENT**:
  ```ts
  export interface SourceAdapter<Raw = unknown> {
    source: string
    toNormalizedEvents(raw: Raw): Either.Either<readonly NormalizedEvent[], AdapterError>
  }
  export interface SecondaryProcessor {
    name: string
    process(event: Event): Promise<void>   // INTERFACE ONLY — no processors implemented this feature
  }
  ```
- **GOTCHA**: do **not** implement any adapter/processor here; concrete adapters are AWE-156/157.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core typecheck`

#### CREATE `src/index.ts` (public surface)
- **IMPLEMENT**: re-export schemas, types, `compileMappingConfig`, `transform`,
  `loadMappingConfig`, `readConfigFile`, `matchKey`, both interfaces, and the error classes.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core build`

#### CREATE exemplars + specs
- **IMPLEMENT**: `valid-config-*.json` (incl. one with `secondaryProcessing`), `invalid-config-*.json`
  (unknown shape; out-of-range priority; unknown processor name). Specs cover: valid parse,
  invalid parse (typed left), classification via map, **default fallback on unmapped trigger**,
  priority pass-through, config-driven `name` override + normalizer fallback, and unknown
  `secondaryProcessing` reported.
- **PATTERN**: `.agents/tests.md` exemplars (`valid-*`/`invalid-*`); `defineProject` name.
- **VALIDATE**: `pnpm --filter @personal-events/integration-core test`

#### CREATE the feature ADR
- **IMPLEMENT**: the three ADR files documenting the integration-template + dual-path (webhook +
  poller) design; status `Accepted`; add the README index row.
- **PATTERN**: `.agents/guidance/adr.md` three-file layout.
- **VALIDATE**: `test -f docs/decisions/*/adr-body.md && grep -R "integration-template" README.md`

### Testing strategy
- **Unit**: pure functions only — `matchKey` (order independence, channel separation),
  `compileMappingConfig` (rule→map, default carried), `transform` (classification, priority,
  name override/fallback, fallback-on-miss, typed left on bad candidate), `loadMappingConfig`
  (valid/invalid/unknown-processor). Drive from `exemplars/`.
- **Integration**: none — no I/O in this package (the only I/O, `readConfigFile`, is exercised
  with a real temp file via a fixture).
- **Edge cases**: empty `rules` (everything → default); duplicate trigger keys (last wins,
  asserted + documented); `secondaryProcessing: []`; trigger field-order independence; a config
  priority of 0 or 9 rejected by schema.

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @personal-events/integration-core exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/integration-core typecheck`
- Level 3 — Unit tests: `pnpm --filter @personal-events/integration-core test`
- Level 4 — Whole-graph: `pnpm build && pnpm lint && pnpm test` (green from the repo root)
