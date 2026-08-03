---
id: AWE-153
title: Core layer contracts (@personal-events/core)
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
branch: feature/minimal-event-pipeline
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-03
---

# Story: Core layer contracts (@personal-events/core)

> **Restructured 2026-08-03.** Re-scoped from *Reusable integration template (`integration-core`)*
> and moved out of `github-integration` — it was never GitHub-specific, and its placement there
> transitively blocked every other integration. **Dropped:** `SourceAdapter` and
> `SecondaryProcessor` (no implementations, deferred execution model) and the `channel` discriminant
> with its compile-to-`ReadonlyMap` step, which existed to reconcile GitHub's two API namespaces —
> AWE-157 was abandoned, leaving one channel per integration and a plain string trigger key.

## Definition

### User story

As the developer adding an event source to personal-events
I want the layering from ADR `2026-08-03-0028-layered-architecture` expressed as real types — a
Transformer contract, a Repository contract, and a config-driven classifier
So that each new integration is a 3P schema plus a transformer plus a config file, and no provider's
wire shape can leak above the Repository boundary.

### Acceptance criteria

- A `@personal-events/core` workspace package exports:
  - **`NormalizedEvent`** — the provider-agnostic intermediate a Transformer produces: `source`,
    `name`, `timestamp`, `trigger` (the mapping key), optional `workItem`, and the raw `payload`. It
    carries **no** `eventType` and **no** `priority` — those are the classifier's job.
  - **`MappingConfig`** — `integration`, a `rules` record keyed by trigger string, and a **required
    `default`**, so an unmapped trigger is never silently dropped.
  - **`classify`** — a pure `(config) => (normalized) => Either<Classified, ClassificationError>`,
    where `Classified` carries the canonical `Event` **and a `usedDefault` flag** so callers can log
    an unmapped trigger.
  - **`Transformer<Raw>`** — the contract every integration implements: `source` plus a pure
    `toNormalized(raw): Either<NormalizedEvent, TransformError>`.
  - **`EventRepository`** — the write-side Repository contract as an Effect `Context.Tag`. The
    implementation lives in AWE-213; nothing in this package touches S3 or the AWS SDK.
  - Typed error classes as `Schema.TaggedError`.
- **The package is pure except for one module.** `readMappingConfig` (file → validated config) is the
  sole I/O and lives in its own module; everything else is total and testable without a runtime.
- Validation: a well-formed mapping config parses; a malformed one yields a typed failure naming what
  was wrong. An out-of-range priority or a dotted `source`/`name` in config is rejected by the
  schema, not discovered later at write time.
- **Field bounds are imported, never re-declared** — `Priority`, `NoDotString` and `IsoInstant` come
  from `@personal-events/event-model` (AWE-150). Re-declaring the 1–8 bound or the no-dot rule here
  forks the contract and is a review gate.
- Unit tests cover: valid/invalid config parse, classification via a matched rule, **fallback to
  `default` with `usedDefault: true`**, the optional `name` override, priority pass-through, and a
  config whose output would produce an invalid `Event`.
- **Failure modes:** malformed config file, unreadable/missing config path, a trigger absent from the
  rules (→ default, not an error), and an output that fails `Event` validation each produce a clear
  typed failure or a documented fallback.
- Guidance conformance: Effect throughout per ADR `2026-08-03-0035-effect-as-default-idiom`
  (`Either` for the pure classifier, `Effect` for the config read); module SRP; no enums; no
  accumulator loops; `Record` lookup over branching.

### Notes / Open questions

- **`Service` is deliberately not a marker interface.** The layering names a Service layer, but a
  generic `interface Service {}` carries no information and would be abstraction for its own sake —
  exactly the failure the original version of this story made. Core's Service layer is realized as
  the concrete `classify` function; each integration's own service is its concrete composition.
- **The Repository contract is write-side only.** F2's AWE-152 needs reads and will extend the
  contract when it does. Defining read methods now, before a consumer exists, would repeat the
  `SourceAdapter` mistake.
- Depends on AWE-150 (`event-model`) for `Event`, `parseEvent` and the field schemas, and on AWE-149
  for the package tooling.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This package is
> **pure Compute plus one Gather module** — no Persist phase exists here (the S3 write is AWE-213).
> Do not restate the user story.

### Decisions resolved during planning

- **Trigger is a plain `string`, not a discriminated structure.** With AWE-157 abandoned each
  integration has exactly one channel, so a trigger is just `"pull_request.opened"` or `"Stop"`. This
  removes `matchKey`, order-independent key canonicalization, and the compile step entirely.
- **`rules` is a `Schema.Record`, not an array of rules.** Keying by trigger string gives O(1) lookup
  natively with no compile pass, and makes duplicate triggers impossible by construction (the old
  array form needed a documented last-wins rule).
- **`classify` returns `usedDefault`.** F4 and F5 both require logging an unmapped trigger that fell
  back to the default. Returning the flag beats a second lookup or a side-channel.
- **`classify` re-validates through `parseEvent`.** The assembled candidate goes back through the
  `event-model` schema so a bad config value surfaces as a typed `Left` rather than an invalid event
  reaching S3.
- **Repository contract lives here, implementation in AWE-213.** Consumers depend on the tag, not on
  S3 — that is what makes the layering real rather than decorative.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Layering** (ADR `2026-08-03-0028-layered-architecture`): this package *defines* the boundary.
  Nothing here may import an AWS SDK, an HTTP client, or any provider type. **If a third-party name
  appears anywhere in this package, the design is wrong.**
- **Gather / Compute / Persist** (`general.md`): `classify`, the schemas and `Transformer` are
  **Compute** — pure and total. `readMappingConfig` is the single **Gather** touchpoint and lives in
  its own module. There is **no Persist** phase here.
- **Effect idiom** (ADR `2026-08-03-0035-effect-as-default-idiom`): pure fallible → `Either`;
  effectful → `Effect`. `classify` and `toNormalized` return `Either`; `readMappingConfig` returns
  `Effect`. No raw `Promise` anywhere in this package.
- **Module-level SRP** (`general.md`): one axis of change per file — schemas, classifier, transformer
  contract, repository contract, errors, and config I/O each get their own module even though several
  have one consumer today.
- **No enums** (`typescript.md`): `eventType` is `Schema.Literal`; any runtime list is `as const`.
- **No accumulator loops** (`typescript.md`): none should be needed; if one appears, express it as a
  pipeline. Read `.agents/code-examples/typescript/src/looping.ts` before writing iteration.
- **Branch selection** (`typescript.md`): rule resolution is a `Record` lookup with an explicit
  default — never an `if`/`else if` chain.
- **Return values** (`typescript.md`): explicit return types everywhere; no bare `null`/`undefined`.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `.agents/plans/minimal-event-pipeline/event-model-package.md` (AWE-150) — Why: the exact exports
  this package consumes. Note `EventSchema`, `Event`, `parseEvent` (returns `Either<Event, string>`),
  and the field schemas `Priority = Schema.Int.pipe(Schema.between(1,8))`,
  `NoDotString = Schema.NonEmptyString.pipe(Schema.pattern(/^[^.]+$/))`, `IsoInstant`.
- `.agents/plans/minimal-event-pipeline/monorepo-bootstrap.md` (AWE-149) — Why: the package skeleton
  to mirror — `tsconfig.json` extends the root base with `composite: true`; tsup
  `entry: ["src/index.ts"]`, `format: ["esm"]`, `target: "node24"`, `dts: true`; vitest via the root
  `test.projects`; biome semicolons `asNeeded`, double quotes, width 140.
- `docs/decisions/2026-08-03-0028-layered-architecture/adr-body.md` — Why: the layer definitions this
  package encodes, and the "Transformers are the only code permitted to know a foreign shape" rule.
- `docs/decisions/2026-08-03-0035-effect-as-default-idiom/adr-body.md` — Why: the
  `Effect`/`Either`/`Option` rule-of-thumb table this package must follow.
- `.agents/cache/effect/v3/_main/schema.md` — Why: `Schema.Struct`, `Schema.Record`, `Schema.Literal`,
  `Schema.optionalWith`, `Schema.TaggedError`, `Schema.decodeUnknownEither`.
- `.agents/languages/typescript/typescript.md` §Return Values, §Branch Selection, §Enums.

### Files to create / change

- `packages/core/package.json` — `@personal-events/core`, private, `type: module`; dependencies
  `effect`, `@personal-events/event-model` (`workspace:*`), `@effect/platform`; scripts per AWE-149.
- `packages/core/tsconfig.json` — extends root base, `composite: true`.
- `packages/core/tsup.config.ts` — mirror the AWE-149 shape, `dts: true`.
- `packages/core/src/normalized-event.ts` — `NormalizedEventSchema` + `NormalizedEvent` type.
- `packages/core/src/mapping-config.ts` — `OutputSchema`, `MappingConfigSchema`, derived types.
- `packages/core/src/classify.ts` — `Classified` type and the curried pure `classify`.
- `packages/core/src/transformer.ts` — the `Transformer<Raw>` contract (types only).
- `packages/core/src/event-repository.ts` — `PutOutcome` and the `EventRepository` `Context.Tag`.
- `packages/core/src/errors.ts` — `TransformError`, `ClassificationError`, `ConfigParseError`,
  `ConfigReadError`, `EventWriteError` as `Schema.TaggedError`.
- `packages/core/src/config-file.ts` — `readMappingConfig(path)` (the only I/O in the package).
- `packages/core/src/index.ts` — public re-exports.
- Co-located specs: `mapping-config.spec.ts`, `classify.spec.ts`, `config-file.spec.ts`.
- `packages/core/exemplars/` — `valid-config-*.json` and `invalid-config-*.json`.

### Relevant documentation

- [effect Schema basic usage](https://effect.website/docs/schema/basic-usage/) — Why: `Struct`,
  `Record`, `Literal`, `optionalWith` signatures.
- [effect Schema error formatters](https://effect.website/docs/schema/error-formatters/) — Why:
  `TreeFormatter` + `{ errors: "all" }` for readable typed config failures.
- [effect Services / Context](https://effect.website/docs/requirements-management/services/) — Why:
  the `Context.Tag` shape for `EventRepository`.
- [@effect/platform FileSystem](https://effect.website/docs/platform/file-system/) — Why: the
  Effect-native file read for `readMappingConfig`, rather than `node:fs` + `Effect.tryPromise`.

### Patterns to follow

- **Mapping config** (`src/mapping-config.ts`):
  ```ts
  import { Schema } from "effect"
  import { NoDotString, Priority } from "@personal-events/event-model"

  export const OutputSchema = Schema.Struct({
    eventType: Schema.Literal("alert", "notification"),
    priority: Priority,
    name: Schema.optionalWith(NoDotString, { exact: true })   // optional label override
  })
  export type Output = typeof OutputSchema.Type

  export const MappingConfigSchema = Schema.Struct({
    integration: NoDotString,
    rules: Schema.Record({ key: Schema.String, value: OutputSchema }),
    default: OutputSchema                                     // required — nothing is dropped
  })
  export type MappingConfig = typeof MappingConfigSchema.Type
  ```
- **Classifier** (`src/classify.ts`) — a `Record` lookup with an explicit default, then re-validate:
  ```ts
  export interface Classified { readonly event: Event; readonly usedDefault: boolean }

  export const classify = (config: MappingConfig) =>
    (normalized: NormalizedEvent): Either.Either<Classified, ClassificationError> => {
      const matched = config.rules[normalized.trigger]        // Output | undefined
      const output = matched ?? config.default
      const candidate = {
        schemaVersion: 1,
        timestamp: normalized.timestamp,
        eventType: output.eventType,
        priority: output.priority,
        source: normalized.source,
        name: output.name ?? normalized.name,
        acknowledged: false,
        handled: false,
        payload: normalized.payload,
        ...(normalized.workItem === undefined ? {} : { workItem: normalized.workItem })
      }
      return pipe(
        parseEvent(candidate),
        Either.map(event => ({ event, usedDefault: matched === undefined })),
        Either.mapLeft(detail => new ClassificationError({ trigger: normalized.trigger, detail }))
      )
    }
  ```
- **Repository contract** (`src/event-repository.ts`) — the tag only, no implementation:
  ```ts
  export interface PutOutcome { readonly _tag: "Created" | "AlreadyExists"; readonly key: string }

  export class EventRepository extends Context.Tag("@personal-events/core/EventRepository")<
    EventRepository,
    {
      readonly put: (event: Event) => Effect.Effect<PutOutcome, EventWriteError>
      readonly putAll: (events: readonly Event[]) => Effect.Effect<readonly PutOutcome[], EventWriteError>
    }
  >() {}
  ```
- **Errors** (`src/errors.ts`):
  ```ts
  export class ClassificationError extends Schema.TaggedError<ClassificationError>()(
    "ClassificationError", { trigger: Schema.String, detail: Schema.String }
  ) {}
  ```
- **Logging:** this package emits **none**. Failures are typed values; the caller logs them per
  `.agents/guidance/logging.md`.

### Codebase irregularities to ignore

- **`tsup`, not `tsdown`.** `.agents/frameworks/node/preferences.md` mentions tsdown and AWE-162's
  plan specifies it, but the monorepo standard set by AWE-149 — and restated in AWE-150 — is
  **tsup**. Follow AWE-149.
- **Older effect material references `@effect/schema`** as a separate package. Schema merged into
  core `effect` at 3.10; import from `"effect"`. Target **v3.21**, not the v4 beta whose API differs
  (`Schema.Literals`, `isBetween`).
- **This story's own git history** contains a `channel`-discriminated trigger, `matchKey`, a
  `compileMappingConfig` step, and `SourceAdapter`/`SecondaryProcessor` interfaces. All were dropped
  on 2026-08-03 — do not reintroduce them from the earlier revision.
- `.agents/object-types.md` is NestJS-flavoured (constructor DI, `*.service.ts` naming). Apply its
  *spirit* (transformers between boundary shapes, SRP) but not its DI mechanics — Effect `Layer` is
  this project's DI, per the Effect ADR.

### Step-by-step tasks

Execute in order, top to bottom.

#### CREATE `packages/core/` package skeleton
- **IMPLEMENT**: `package.json`, `tsconfig.json`, `tsup.config.ts` for `@personal-events/core`.
- **PATTERN**: the placeholder package shape from AWE-149; `effect`, `@effect/platform` and
  `@personal-events/event-model` in `dependencies`.
- **GOTCHA**: `composite: true` **and** `dts: true`, or AWE-213 and the integration packages cannot
  consume the types.
- **VALIDATE**: `pnpm install && pnpm --filter @personal-events/core build`

#### CREATE `src/errors.ts`
- **IMPLEMENT**: `TransformError`, `ClassificationError`, `ConfigParseError`, `ConfigReadError`,
  `EventWriteError` as `Schema.TaggedError` subclasses, each carrying the fields needed to diagnose
  it without a stack trace.
- **GOTCHA**: `EventWriteError` belongs here because the *contract* does; its only thrower is
  AWE-213's implementation.
- **VALIDATE**: `pnpm --filter @personal-events/core typecheck`

#### CREATE `src/normalized-event.ts` + `src/mapping-config.ts`
- **IMPLEMENT**: both schemas and derived types, importing `Priority`/`NoDotString`/`IsoInstant` from
  `@personal-events/event-model`.
- **GOTCHA — the cross-story contract**: if AWE-150 has not exported those field schemas, **stop and
  add the export there**; do not re-declare the 1–8 bound or the no-dot pattern locally.
- **GOTCHA**: `exactOptionalPropertyTypes` is on in the base tsconfig — use
  `Schema.optionalWith(..., { exact: true })` for `name` and `workItem`.
- **VALIDATE**: `pnpm --filter @personal-events/core typecheck`

#### CREATE `src/classify.ts`
- **IMPLEMENT**: `Classified` and the curried `classify` exactly as in Patterns.
- **IMPORTS**: `{ Either, pipe }` from `"effect"`; `parseEvent`, `type Event` from
  `@personal-events/event-model`.
- **GOTCHA**: `noUncheckedIndexedAccess` makes `config.rules[trigger]` yield `Output | undefined` —
  that is intentional and drives both the `??` fallback and the `usedDefault` flag.
- **VALIDATE**: `pnpm --filter @personal-events/core test classify`

#### CREATE `src/transformer.ts` + `src/event-repository.ts`
- **IMPLEMENT**: the `Transformer<Raw>` interface and the `EventRepository` `Context.Tag`.
- **GOTCHA**: **types and tags only — no implementations.** An implementation appearing here is the
  same mistake the dropped `SourceAdapter` made.
- **VALIDATE**: `pnpm --filter @personal-events/core typecheck`

#### CREATE `src/config-file.ts` (the only I/O)
- **IMPLEMENT**: `readMappingConfig(path)` returning
  `Effect<MappingConfig, ConfigReadError | ConfigParseError, FileSystem>` — read the file, parse the
  JSON, decode via `Schema.decodeUnknownEither(MappingConfigSchema, { errors: "all" })`, and map the
  parse failure through `TreeFormatter` into `ConfigParseError`.
- **PATTERN**: `@effect/platform` `FileSystem` rather than `node:fs` + `Effect.tryPromise`, so the
  read is testable by providing a layer.
- **GOTCHA**: keep this module free of classification logic — it Gathers and validates, nothing more.
- **VALIDATE**: `pnpm --filter @personal-events/core test config-file`

#### CREATE `src/index.ts`
- **IMPLEMENT**: re-export the schemas, derived types, `classify`, `Classified`, `Transformer`,
  `EventRepository`, `PutOutcome`, `readMappingConfig`, and every error class.
- **VALIDATE**: `pnpm --filter @personal-events/core build`

#### CREATE exemplars + specs
- **IMPLEMENT**: `valid-config-minimal.json`, `valid-config-with-name-override.json`,
  `invalid-config-missing-default.json`, `invalid-config-bad-priority.json`,
  `invalid-config-dotted-source.json`. Specs assert: valid parse; each invalid parse yields a typed
  failure naming the field; a matched rule classifies with `usedDefault: false`; an unmatched trigger
  falls back with `usedDefault: true`; `output.name` overrides `normalized.name` and is absent
  otherwise; priority passes through; and a config output that would produce an invalid `Event`
  yields `ClassificationError`.
- **PATTERN**: `.agents/tests.md` exemplars (`valid-*` / `invalid-*`), driven as a table.
- **VALIDATE**: `pnpm --filter @personal-events/core test`

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: reconcile against `.agents/general.md` and `.agents/languages/typescript/*`: module
  SRP (one axis each); pure Compute with sliced params; no accumulator loops; no enums; `Record`
  lookup over branching; explicit return types; arrow functions. Confirm the package imports nothing
  provider-specific and no AWS SDK.
- **VALIDATE**: `pnpm --filter @personal-events/core exec biome check src` and
  `pnpm --filter @personal-events/core typecheck` both clean.

### Testing strategy

- **Unit**: pure-function tables driven from `exemplars/` — config parse (valid + each failure mode),
  classification (matched, default-fallback, name override, priority pass-through), and the
  invalid-output path. No mocks; nothing here has ambient dependencies.
- **Integration**: only `readMappingConfig`, exercised against a real temp file via an
  `@effect/platform` `FileSystem` layer — a genuine read, not a mock, per `.agents/tests.md`.
- **Edge cases**: empty `rules` (everything → default); a trigger key containing dots (legal — it is
  an opaque string, unlike `source`/`name`); `priority` 0 and 9 rejected by schema; a config whose
  `default` is missing; a `name` override containing a dot (rejected by `NoDotString`).

### Validation commands

- Level 1 — Syntax & style: `pnpm --filter @personal-events/core exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/core typecheck`
- Level 3 — Unit + integration: `pnpm --filter @personal-events/core test`
- Level 4 — Whole-graph: `pnpm build && pnpm lint && pnpm test` green from the repo root, and a
  sibling package can `import { classify, EventRepository, type Transformer } from "@personal-events/core"`.
