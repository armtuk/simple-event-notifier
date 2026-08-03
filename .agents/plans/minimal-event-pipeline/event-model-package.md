---
id: AWE-150
title: Shared event-model package
type: story
status: ready
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-06-28
---

# Story: Shared event-model package

## Definition

### User story
As any producer or consumer of personal-events
I want the event shape and its S3 object-key naming scheme defined once in a shared package
So that every component agrees on the same versioned contract and I never hand-roll
serialization or key parsing again.

### Acceptance criteria
- A `@personal-events/event-model` workspace package exports the canonical event schema using
  **effect Schema** (the project default), with fields per the README:
  `timestamp` (ISO instant), `eventType` (`alert` | `notification`), `priority` (1–8),
  `source`, `name`, `acknowledged` (bool), `handled` (bool), `workItem` (optional URL string),
  and `payload` (opaque JSON).
- Validation: a well-formed event parses to a typed value; a malformed event yields a typed
  failure (not a thrown bare error), following the result/`Either` conventions in
  `.agents/languages/typescript/typescript.md`.
- Object-key codec: a `buildKey(event)` produces
  `{timestamp}.{type}.{priority}.{source}.{name}.json` (e.g.
  `2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json`), and `parseKey(key)`
  round-trips it back into its components, failing typed on a malformed key.
- `eventType` and priority are modelled as `as const` objects / literal unions — **no TS
  enums** (per guidance).
- Unit tests (vitest) cover: valid parse, invalid parse, key build, key parse, and
  round-trip `event → key → components` for representative events including edge cases
  (priority bounds, names containing dots/special chars, missing optional `workItem`).
- The package builds with tsup and is consumable by other workspace members via `.ts`
  imports.
- **Failure modes:** out-of-range priority, unknown `eventType`, a non-ISO timestamp, and a
  key with the wrong segment count each produce a clear typed failure.

### Notes / Open questions
- The key encodes `priority` as `p{n}` (e.g. `p5`) per the README example — confirm and lock
  this during `/plan-story`.
- Open: how to escape/normalize `source`/`name` segments that could contain the `.` delimiter
  so keys stay unambiguously parseable.
- Open: whether to carry an explicit `schemaVersion` field now to make the contract's
  versioning explicit from day one (recommended).
- Depends on **monorepo-bootstrap** (AWE-149) for the package tooling.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This package
> is the **load-bearing contract** — treat the schema and key codec as a versioned interface.
> Build pure, total functions; no I/O lives here.

### Decisions resolved during planning (open questions answered)
- **`schemaVersion` field: YES, add it now** — `Schema.Literal(1)` (numeric, so it can join a
  `Schema.Union(Literal(1), Literal(2), …)` later). Cheap forward-compat for events that sit in
  S3 as permanent history across future schema changes.
- **Priority encoded as `p{n}`** in the key (confirmed from README example `p5`).
- **Dot-delimiter ambiguity (the key open question): constrain `source` and `name` to a
  no-dot pattern** (`NonEmptyString.pipe(Schema.pattern(/^[^.]+$/))`). This makes the dotted
  key unambiguously parseable AND validates inputs. Producers normalize dotted values (e.g.
  `github.com` → `github-com`) before constructing an event. The timestamp segment keeps its
  internal `.` for milliseconds but is matched by a fixed ISO regex, so it stays unambiguous.
- **Key codec implementation: use `Schema.transform(Schema.String, EventKeyComponents, …)`
  with an explicit anchored regex** (research "Option B") rather than
  `Schema.TemplateLiteralParser`. The regex is explicit, unit-testable in isolation, and
  avoids TemplateLiteralParser's literal-in-tuple awkwardness and its generated-regex
  greediness around dotted segments.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md and .agents/languages/typescript/typescript.md. -->
- **Pure / total functions** (`general.md` Compute phase): the schema, `buildKey`, and
  `parseKey` are pure — no I/O, no logging, deterministic. This is the Compute/Transform layer
  for every consumer; it must contain zero Gather/Persist.
- **Return Values / Objects** (`typescript.md`): no function returns bare `null`/`undefined`;
  parse entry points return `Either<A, ErrorMessage>` (effect convention). Throwing is allowed
  only *inside* a `Schema.transform.decode` callback (effect converts it to a `ParseError`).
- **No enums** (`typescript.md`): `eventType` is `Schema.Literal("alert","notification")`;
  expose the values as an `as const` object too if a runtime list is useful.
- **No accumulator loops** (`typescript.md`): tests and any helpers use `map`/`filter`/`reduce`.
- **Separation at module level** (`general.md`): split `event.ts` (the domain schema/types),
  `event-key.ts` (the key codec), and `parse.ts` (the boundary decode helpers) — each has one
  axis of change. `index.ts` re-exports the public surface.
- **CQRS/layering**: n/a here — this is a shared domain/contract package, not an API layer.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/frameworks/effect/index.md` — Why: Schema basics, `Schema.Struct`,
  `Schema.TaggedError`, decode patterns; subpath-import guidance for tree-shaking.
- `.agents/frameworks/effect/v3/_main/schema.md` — Why: exact filter/transform/template APIs
  (`between`, `pattern`, `transform`, `TemplateLiteralParser`, `optionalWith`, `URL`).
- `.agents/languages/typescript/typescript.md` (Return Values, Enums, Looping sections) —
  Why: the result-type and no-enum/no-loop rules this package must follow.
- `.agents/languages/typescript/typescript-testing.md` and `.agents/tests.md` — Why: `.spec.ts`
  co-located, happy + sad paths, **exemplars** directory for representative real data.
- `.agents/code-examples/typescript/package.json` — Why: effect version (`^3.21`) and the
  tsup/vitest setup to mirror for this package.

### Files to create / change
- `packages/event-model/package.json` — `@personal-events/event-model`, `type: module`,
  `effect` in **`dependencies`** (auto-externaled by tsup), tsup build, vitest test, exports map.
- `packages/event-model/tsconfig.json` — extends root base; `composite: true`.
- `packages/event-model/tsup.config.ts` — `entry: ["src/index.ts"]`, `format: ["esm"]`,
  `target: "node24"`, `dts: true`, `clean: true`, `splitting: false`.
- `packages/event-model/src/event.ts` — `EventSchema` (`Schema.Struct`), the reusable field
  schemas (`IsoInstant`, `NoDotString`, `Priority`), `schemaVersion: Schema.Literal(1)`, and
  `export type Event = typeof EventSchema.Type` / `EventEncoded = typeof EventSchema.Encoded`.
- `packages/event-model/src/event-key.ts` — `EventKeyComponents` struct, `EventKeySchema`
  (`Schema.transform`), and pure `buildKey(event)` / `parseKey(key)` wrappers.
- `packages/event-model/src/parse.ts` — `parseEvent(raw: unknown): Either<Event, string>` using
  `Schema.decodeUnknownEither(EventSchema, { errors: "all" })` + `Either.mapLeft` +
  `ParseResult.TreeFormatter.formatErrorSync`.
- `packages/event-model/src/index.ts` — public re-exports (schema, types, codec, parse helpers).
- `packages/event-model/src/event.spec.ts`, `event-key.spec.ts`, `parse.spec.ts` — co-located.
- `packages/event-model/exemplars/` — `valid-*.json` (well-formed events incl. github example)
  and `invalid-*.json` (bad priority, unknown type, non-ISO timestamp, dotted source) driving
  the spec table.

### Relevant documentation
- [effect Schema basic usage](https://effect.website/docs/schema/basic-usage/) — Why: Struct,
  Literal union, optional, Record/Unknown primitives.
- [effect Schema filters](https://effect.website/docs/schema/filters/) — Why: `between`, `int`,
  `pattern` exact signatures for priority and the no-dot constraint.
- [effect Schema transformations](https://effect.website/docs/schema/transformations/) — Why:
  `Schema.transform` for the key codec.
- [effect Schema error formatters](https://effect.website/docs/schema/error-formatters/) —
  Why: `TreeFormatter`/`ArrayFormatter` and `{ errors: "all" }` for readable typed failures.
- [Importing Effect / tree-shaking](https://effect.website/docs/getting-started/importing-effect/)
  — Why: prefer subpath imports (`effect/Schema`) under tsup/esbuild.

### Patterns to follow
- **Version:** `effect@^3.21` (use `import { Schema, ParseResult, Either } from "effect"`, or
  subpath `effect/Schema` etc. for better esbuild tree-shaking).
- **Field schemas** (from research, adapt):
  - `IsoInstant = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/))`
  - `Priority = Schema.Int.pipe(Schema.between(1, 8))`
  - `NoDotString = Schema.NonEmptyString.pipe(Schema.pattern(/^[^.]+$/))`
  - `workItem: Schema.optionalWith(Schema.URL, { exact: true })`
  - `payload: Schema.Record({ key: Schema.String, value: Schema.Unknown })`
- **Key regex (anchored):**
  `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\.(alert|notification)\.p(\d+)\.([^.]+)\.([^.]+)\.json$`
- Annotate exported schema consts with `/*#__PURE__*/` (effect tree-shaking issue #5967).

### Codebase irregularities to ignore
- Some older effect material references `@effect/schema` as a separate import — **do not** use
  it; Schema merged into the core `effect` package at 3.10. Import from `"effect"`.
- effect v4 (beta) renames many APIs (`decodeUnknownExit`, `Schema.Literals([...])`,
  `Schema.between` → `isBetween`). We target **v3.21**; ignore v4 signatures.
- The Effect team migrated their own builds tsup→tsdown — irrelevant here; the monorepo
  standard is **tsup** (from AWE-149). Do not introduce tsdown.

### Step-by-step tasks
Execute in order.

#### CREATE packages/event-model scaffold
- **IMPLEMENT**: package.json/tsconfig/tsup.config for `@personal-events/event-model`.
- **PATTERN**: mirror the placeholder package from AWE-149; `effect` in `dependencies`.
- **VALIDATE**: `pnpm --filter @personal-events/event-model build` (emits dist + dts).

#### CREATE src/event.ts (schema + types)
- **IMPLEMENT**: field schemas, `EventSchema`, `schemaVersion: Schema.Literal(1)`, derived
  `Event`/`EventEncoded` types; optional `eventTypes` `as const` list.
- **GOTCHA**: `exactOptionalPropertyTypes` (from base tsconfig) means `workItem?` must use
  `optionalWith(..., { exact: true })` so present-but-`undefined` is rejected.
- **VALIDATE**: `pnpm --filter @personal-events/event-model typecheck`.

#### CREATE src/event-key.ts (codec) + src/parse.ts (boundary)
- **IMPLEMENT**: `EventKeySchema` via `Schema.transform` with the anchored regex; pure
  `buildKey`/`parseKey`; `parseEvent` returning `Either<Event,string>`.
- **PATTERN**: research §4 Option B + §3 decode pattern.
- **GOTCHA**: priority parsed via `parseInt(.., 10)` then validated `between(1,8)`; reject
  segment counts that don't match the regex.
- **VALIDATE**: `pnpm --filter @personal-events/event-model typecheck`.

#### CREATE exemplars + spec files
- **IMPLEMENT**: valid/invalid exemplar JSON + spec tables asserting parse success/typed
  failure, `buildKey` output equality, `parseKey` components, and `event → key → parseKey`
  round-trip.
- **PATTERN**: `.agents/tests.md` exemplars; `describe`/`it` per
  `.agents/languages/typescript/typescript-testing.md`.
- **VALIDATE**: `pnpm --filter @personal-events/event-model test`.

#### REFACTOR — guidance conformance pass (general.md + TS guidance)
- **IMPLEMENT**: After the schema/codec/tests pass, do a dedicated conformance pass against
  `.agents/general.md` and `.agents/languages/typescript/typescript.md`: (1) module-level SRP —
  `event.ts` / `event-key.ts` / `parse.ts` each own one axis of change; relocate any concern
  parked where it happened to be written; (2) pure/total Compute — `buildKey`/`parseKey` and any
  formatters take sliced params, no I/O; (3) no accumulator loops in helpers or tests
  (map/filter/reduce); (4) no enums (`as const`/literals), `Record` lookups over if/else chains;
  (5) `Either`/object result types with explicit return types, `async` on any promise-returning
  fn; (6) arrow functions by default. Fix anything that drifted during implementation.
- **VALIDATE**: `pnpm --filter @personal-events/event-model exec biome check src` and
  `pnpm --filter @personal-events/event-model typecheck` clean; optionally run `/simplify` on the diff.

### Testing strategy
- **Unit**: pure-function tables driven by the `exemplars/` JSON — valid parse, each failure
  mode (out-of-range priority, unknown eventType, non-ISO timestamp, dotted source/name,
  wrong segment count), `buildKey`/`parseKey`, and full round-trip. No mocks needed (no I/O).
- **Integration**: n/a (pure package).
- **Edge cases**: priority bounds (1 and 8 pass; 0 and 9 fail), missing optional `workItem`,
  `name` with hyphens, ms-less timestamp, and a key with an extra/missing dotted segment.

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @personal-events/event-model exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/event-model typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/event-model test`
- Level 4 — Build/consume: `pnpm --filter @personal-events/event-model build` then confirm a
  sibling package can `import { EventSchema, buildKey, parseKey, parseEvent } from "@personal-events/event-model"`.
