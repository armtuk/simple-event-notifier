---
id: AWE-150
title: Shared event-model package
type: story
status: Completed
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
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

## Execution notes (2026-07-19)

Deltas from the plan as written, and why:

- **`.agents/cache/effect/**` does not exist in this repo** — the Effect API reference the plan
  points at was never generated (`/update-effect-docs` has not been run here). The API surface was
  instead verified empirically against the installed `effect` typings
  (`node_modules/.pnpm/effect@3.22.0/.../dist/dts/Schema.d.ts`) before use, and every call is
  covered by a green `tsc --noEmit`. **Recommend running `/update-effect-docs` in this repo** so
  later Effect stories are not doing the same archaeology.
- **effect resolved to 3.22.0** (catalog `^3.22.0`), not 3.21 — same v3 era, no API drift for what
  is used here.
- **`Schema.transformOrFail`, not `Schema.transform`.** A regex match over an arbitrary key can
  fail, and `transform`'s decode must be total. `transformOrFail` lets the failure be a real
  `ParseResult.Type` issue carrying the message.
- **Failure type is `EventModelError`, not a bare `string`.** A single tagged interface
  (`_tag: "EventModelError"`, `reason`, `message`) in `errors.ts`, with `reason` drawn from an
  `as const` object (`invalidEvent` | `invalidEventJson` | `invalidEventKey`). It is barely more
  code than a string and lets consumers — notably the AWE-152 daemon — branch on the failure mode
  while still logging one readable message that names the offending value. `message` is the
  `TreeFormatter` rendering, so it names the specific field.
- **`buildKey` is total and takes the five-field slice** (`EventKeyComponents`), not the whole
  event: the components are already schema-valid so formatting cannot fail. `toKeyComponents(event)`
  is the aggregate → slice transform and `buildEventKey(event)` is the composition —
  slice-don't-dump rather than passing the aggregate into the formatter.
- **`encodeEvent` / `encodeEventJson` added.** The plan only specified the decode direction, but a
  producer-facing contract that cannot serialize is half an interface; the spec asserts a
  byte-for-byte `decode → encode` round trip.
- **`parseEventJson` added** with its own `invalidEventJson` reason, so the daemon can tell "the S3
  object was not JSON" apart from "the JSON was not an event".
- **Key regex captures the type segment as `[^.]+`, not `(alert|notification)`**, so an unknown type
  is rejected by `EventTypeSchema` with a message naming `eventType` rather than looking like a
  structurally malformed key. Same reasoning for priority: the regex checks only the *shape* and
  `Priority`'s `between(1, 8)` produces the range message.
  - **Correction (R1 review, finding #3):** as first written this claim was **false**. `matchKey`
    resolved the segment eagerly through a `Partial<Record<string, EventType>>` lookup and folded an
    unresolved type back into the same shape error, so the message never mentioned `eventType`. The
    lookup is gone; the segment is now cast at the boundary with `EventTypeSchema` as the actual
    gate, and `event-key.spec.ts` asserts the message contains `eventType`.
- **Module split as planned** plus `errors.ts` (the failure channel) and `testing/exemplars.ts`
  (the exemplar loader, deliberately outside the published entry point).
- **`packages/_placeholder` deleted** — this package replaces it as the first real member.

Result: 59 specs across `event.spec.ts` / `event-key.spec.ts` / `parse.spec.ts`, all green;
`biome check`, `tsc --noEmit`, and `tsup` (ESM + `.d.ts`) all clean; the built `dist/index.js` was
smoke-tested end to end (exemplar → `parseEvent` → `buildEventKey` → `parseKey`).

## R1 review fixes (2026-07-19)

Applied after the independent R1 pass (`claude-automated-code-review.md` → `## R1 — 2026-07-19`).
Spec count rose 59 → 87.

- **#1 BLOCKER — variable-precision timestamps broke key ordering.** `isoInstantPattern` allowed an
  optional, variable-width fraction. Because `.` (0x2E) sorts below every digit and `Z` (0x5A) above
  every digit, `…02Z…` > `…02.500Z…` and `…02.12Z…` > `…02.123Z…` — an *earlier* event sorted after a
  later one, so a consumer's `StartAfter` high-water mark skipped it **permanently**. Both committed
  exemplars used different precisions, so this was live, not theoretical. The fraction is now
  mandatory and exactly three digits (the shape `Date.prototype.toISOString()` emits), mirrored in
  `eventKeyPattern`; `valid-agent-notification.json` moved to `2026-07-19T09:15:02.000Z`; the
  "millisecond-less timestamp" spec is deleted and replaced by two ordering describe-blocks that
  assert lexicographic order equals chronological order across a mixed table, plus rejection rows
  for every non-three-digit form. Fixed now, this is free; after the first `apply` it is a history
  migration — and the ADR calls the key scheme a one-way door.
- **#3 MAJOR — unknown `eventType` produced a generic shape error**, and the execution note above
  claimed the opposite. Both the code and the claim are corrected (see the corrected bullet).
- **#5 MAJOR — `workItem` was not a byte-stable codec.** `Schema.URL` encodes via `url.toString()`,
  and `URL` normalizes (`https://github.com` → `https://github.com/`, `HTTPS://GitHub.com/Foo` →
  `https://github.com/Foo`). The round-trip spec only passed because the one exemplar carrying a
  `workItem` was already in normal form. With S3 as the permanent source of record, any client doing
  `parseEvent → flip a flag → encodeEvent → PutObject` would have silently rewritten stored bytes.
  Replaced with `WorkItemUrl` — a `Schema.String` filtered on `URL.canParse`, so encode is identity
  and consumers get a `string` (no more `.href` at call sites). Specs now round-trip
  **non-normalized** inputs, which is the property the old spec failed to test.
- **#10 MINOR — the key codec was not injective.** `p(\d+)` accepted `p05`, which decoded to
  priority 5 and re-encoded as `p5`, so two distinct S3 keys denoted one event. Tightened to a single
  digit `p(\d)`; `p0`/`p9` still reach `Priority` and get the range message, while `p05` is now
  rejected. Specs pin both.
- **#7 MAJOR — exemplars and their loader were copy-pasted into the consumer.** Three exemplar files
  were byte-identical in `apps/desktop-notifier/exemplars/`. These files *are* the contract, so a
  drifting copy would let a consumer's suite pass against a stale shape. They are now published from
  this package via a `./testing` subpath export (`readExemplarText`/`readExemplar`/`readExemplarEvent`,
  plus `exemplarReader(dir)` for a consumer's own directory) and an `./exemplars/*` export, with
  `files: ["dist","exemplars"]`. The app's copies are deleted; it keeps only `not-json.txt`, which is
  genuinely its concern.
- **#9 MINOR — `describeCause` was copy-pasted five times.** Now `src/describe-cause.ts`, exported
  from the package root and imported by all four app call sites.
