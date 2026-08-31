---
id: AWE-213
title: S3 event repository & push CLI
type: story
status: ready
parent: ./feature.md
pm-tool: Airtable
pm-record: reciUkHDtjpBg7yvi
pm-url: https://airtable.com/appnae8GXuj1rNVoQ/tblpJmL4dJ7Q4rw3U/reciUkHDtjpBg7yvi
branch: feature/minimal-event-pipeline
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-08-03
updated: 2026-08-31
---

# Story: S3 event repository & push CLI

> **Restructured 2026-08-03.** Absorbs AWE-160 — Shared S3 event writer, which was abandoned. This story now delivers the **Repository** over S3 (the Persist boundary every later producer calls) *and* the `bin` that drives it, rather than a library and a CLI as separate stories. Per ADR `2026-08-03-0035-effect-as-default-idiom` the repository returns `Effect`, not `Promise`.

## Definition

### User story

As someone with a script, cron job, or CI step that just noticed something worth knowing about
I want to push a canonical event into the S3 event bucket with a single command
So that any client — desktop notifier, phone, future Event UI — sees it in the same triage
stream as GitHub and Claude Code events, without me standing up a webhook or hand-building an
object key.

### Acceptance criteria

- **AC-01** — A workspace package **`@personal-events/s3-repository`** (at
  `packages/s3-repository/`) exposes a `bin` entry point named **`event-push`** that accepts:
  `--type` (`alert` | `notification`, required), `--priority` (integer 1–8, required),
  `--source` (required), `--name` (required), `--payload <path|->` (optional; `-` reads stdin),
  `--work-item <url>` (optional), `--bucket <name>` (optional), `--timestamp <iso>` (optional),
  and `--dry-run` (optional).
- **AC-02** — The package provides the **live implementation of the `EventRepository`
  `Context.Tag`** defined by `@personal-events/core` (AWE-153), as an Effect `Layer`. Its `put`
  returns `Effect<PutOutcome, EventWriteError>` exactly as the contract declares. The CLI is a
  *consumer* of that layer, not a parallel code path — AWE-155 and AWE-162 obtain the identical
  `put` by providing the same layer.
- **AC-03** — The assembled event validates against the `@personal-events/event-model` schema
  **before any network call is attempted**, with `acknowledged` and `handled` defaulting to
  `false`. A validation failure performs **zero** S3 requests.
- **AC-04** — The object key is produced **exclusively** by the `event-model` codec
  (`buildKey`). No key string is assembled anywhere in this package, and the field schemas
  `Priority`, `NoDotString` and `IsoInstant` are **imported** from `event-model`, never
  re-declared.
- **AC-05** — **Round-trip parity is proven by test**: for a matrix of inputs — including
  `source` and `name` values containing dots, and boundary priorities **1 and 8** — the key
  produced by `buildKey` parses back through `parseKey` to identical components.
- **AC-06** — The write uses the AWS SDK v3 **default credential chain** (no hardcoded profile)
  and is isolated in a single `put-event.ts` module, so the persist boundary can be swapped in
  one file.
- **AC-07** — **Same-key re-push is a no-op, not an overwrite and not a crash.** The write is a
  conditional put (`IfNoneMatch: "*"`); an existing key yields
  `PutOutcome { _tag: "AlreadyExists" }` and the CLI exits **0** reporting that no write
  occurred. This preserves the append-only history guarantee in `system.md` — an event already
  recorded is never silently replaced.
- **AC-08** — `--dry-run` prints the resolved key and the full event body to stdout, performs
  **zero** network calls, and exits 0.
- **AC-09** — Bucket identity resolves in the documented precedence order
  **`--bucket` > `EVENT_BUCKET` environment variable**, and when resolution fails the error
  names **both** sources that were tried.
- **AC-10** — **Failure modes — each produces a specific, actionable stderr message and a
  documented NON-ZERO exit code**, distinct enough for a script to branch on usage errors versus
  write failures:
  - `--type` not one of `alert`/`notification`; `--priority` non-integer or outside 1–8; any
    required flag missing → **exit 2** (usage);
  - `--payload` path missing, unreadable, or malformed JSON; `-` requested but stdin empty or
    invalid JSON; `--timestamp` not a valid ISO instant → **exit 2** (usage);
  - AWS credentials missing, expired, or lacking `s3:PutObject` → **exit 3**;
  - bucket does not exist, is unreachable, or returns access-denied → **exit 4**;
  - bucket identity unresolvable → **exit 2**.
  Exit codes are documented in the package README.
- **AC-11** — Guidance conformance: G-C-P separation (argv/stdin/env **gather** → pure
  `buildEvent` + key **compute** → `putEvent` **persist**), module SRP, `Either` for pure
  fallible code and `Effect` for effectful code per `CLAUDE.md`, no enums, no accumulator loops,
  `Record` lookups over `if`/`else if` chains. Verified by `biome` + `typecheck`.

### Notes / Open questions

- **Package name resolved (user decision, 2026-08-31): `@personal-events/s3-repository`, binary
  `event-push`.** The prior acceptance criterion named the package `@personal-events/event-push`,
  which contradicted `feature.md` in two places. The package is the Repository boundary; the
  binary is the ergonomic verb. AC-01 supersedes the earlier wording.
- **Open question closed — same-key re-push.** Previously deferred to "whatever AWE-160 settles
  on". AWE-160 was abandoned, and AWE-153's `PutOutcome` already encodes the answer with its
  `"Created" | "AlreadyExists"` tags. AC-07 makes the conditional put explicit.
- **Open question closed — timestamp source.** The event carries `--timestamp` as an *optional
  override*, defaulting to the machine clock. The override exists because replay and the
  round-trip test matrix (AC-05) need deterministic timestamps; clock skew remains a known
  property of a client-stamped log and is recorded as a feature-level risk, not solved here.
- **The stub's claim that this story "does not need AWE-153" is stale** and is corrected by
  AC-02. It was written when AWE-153 was a config-driven integration template; AWE-153 is now the
  layer-contracts package that *defines* `EventRepository`, and `feature.md` orders it before
  this story precisely so this story can implement it. There is still no mapping config here —
  the caller states `--type` and `--priority` explicitly.
- **Exit-code contract is deliberately the inverse of AWE-162 — Publishable hook CLI.**
  `@alexrmturner/claude-events` must exit 0 on failure to protect the interactive agent session;
  this tool must exit non-zero so automation detects a failed push. Both READMEs must call this
  out explicitly — two CLIs in one repo with opposite failure contracts is an easy trap.
- **Logging:** this story resolves the repo-wide open question recorded in `NOW.md` *for its own
  scope only*: **no winston.** `node/preferences.md` ties winston to the explicitly-not-using-Effect
  branch, and `CLAUDE.md` makes Effect binding. Diagnostics go to stderr at the process boundary;
  the repository package itself emits no logs and returns typed failures, matching AWE-153's
  "this package emits none" stance.
- Depends on **AWE-150 — Shared event-model package** (schema + codec), **AWE-153 — Core layer
  contracts** (the `EventRepository` tag and `EventWriteError`), and **AWE-151 — IaC: S3 event
  bucket & delegated DNS** for a real bucket to write to.

## Plan

> Validate the codec and contract surfaces from `event-model` and `core` before writing code —
> importing the wrong symbol, or re-declaring a field schema, forks the published contract. Do
> not restate the user story.

### Decisions resolved during planning

- **Package `@personal-events/s3-repository` at `packages/s3-repository/`**, binary `event-push`
  (user decision). `packages/*` is the library location per AWE-149; the `bin` field is what makes
  it invocable, so it does not belong in `apps/*`.
- **The CLI is a thin shell over the Layer.** `src/main.ts` parses argv, builds the event purely,
  then runs one Effect with `S3EventRepositoryLayer` provided. There is no second write path.
- **Conditional put via `IfNoneMatch: "*"`** — supported by S3 `PutObject`. A `412
  PreconditionFailed` maps to `PutOutcome { _tag: "AlreadyExists" }`, **not** to an error, since
  the desired end state (the event is recorded under that key) already holds.
- **Argument parsing uses `node:util` `parseArgs`** — in the Node ≥24 standard library, so no
  dependency. `commander`/`yargs` would add a dependency for flag parsing this story fully
  specifies.
- **Exit codes: 0 success (including `AlreadyExists`), 2 usage/validation, 3 credentials,
  4 bucket/write.** Distinct ranges let a cron job branch on "I typed it wrong" versus "AWS is
  unreachable", which AC-10 requires.
- **`EVENT_BUCKET` is the environment variable name** — unprefixed `AWS_*` names risk colliding
  with the SDK's own variables. Terraform's `event_bucket_name` output (AWE-151) is how an
  operator learns the value; nothing reads Terraform state at runtime.

### Acceptance evidence design

- **AC-03 (validate before network)**
  - *Defining input property*: an event that is invalid **and** a bucket value that would fail
    loudly if contacted (e.g. a non-existent bucket name).
  - *Direct assertions*: exit 2, a validation message on stderr, and **zero** S3 calls observed.
  - *Evidence command*: `pnpm --filter @personal-events/s3-repository test -- validate-before-network`
  - *Counterexample*: the test asserts the injected S3 client's call count is **0** — a test that
    only checks the exit code would pass even if the tool called S3 first and validated after.
- **AC-04 (codec exclusivity)**
  - *Direct assertions*: no string-concatenation of a key anywhere in the package.
  - *Evidence command*:
    `! rg -n '\.json"' packages/s3-repository/src --glob '!*.spec.ts' | rg -v 'buildKey'`
  - *Counterexample*: a static check, deliberately paired with AC-05's behavioural round-trip —
    grep alone cannot prove the codec was used, only that an obvious second implementation is
    absent.
- **AC-05 (round-trip matrix)**
  - *Defining input property*: inputs that actually carry the awkward properties — `source`/`name`
    containing dots, priorities **1 and 8** (the boundaries, not 3 and 5).
  - *Direct assertions*: `parseKey(buildKey(e))` deep-equals the original components for every
    matrix row.
  - *Evidence command*: `pnpm --filter @personal-events/s3-repository test -- key-round-trip`
  - *Counterexample*: include a key with the wrong segment count and assert a typed failure.
- **AC-07 (idempotent re-push)**
  - *Defining input property*: the **same** event pushed twice against a real bucket.
  - *Direct assertions*: first call → `Created`, exit 0; second → `AlreadyExists`, exit 0, and the
    object's `ETag`/`LastModified` is **unchanged**.
  - *Evidence command*: `bash packages/s3-repository/scripts/live-idempotency.sh`
  - *Counterexample*: assert `LastModified` is unchanged — an implementation that overwrites
    returns success too, so exit code alone cannot distinguish it.
  - *Environment*: production S3 (`events.dev.personal-events.fifthdimensionengineering.com`).
- **AC-09 (precedence)**
  - *Direct assertions*: with both `--bucket` and `EVENT_BUCKET` set to different values,
    `--dry-run` reports the `--bucket` value; with neither, the error names both.
  - *Evidence command*: `pnpm --filter @personal-events/s3-repository test -- bucket-precedence`
- **AC-10 (exit codes) — complete-set inventory.** The criterion says *each* failure mode, so the
  supported set is enumerated explicitly and each member executed: bad `--type`, bad `--priority`
  (non-integer), `--priority` 0, `--priority` 9, missing `--source`, missing `--name`, missing
  `--payload` file, malformed payload JSON, empty stdin with `-`, bad `--timestamp`, unresolvable
  bucket, bad credentials, non-existent bucket. **13 cases**, each asserting the specific exit
  code — driven by a table-driven test that fails if the table's length changes without the
  inventory being updated.
- **Live integration (AC-06/AC-07)**: `packages/s3-repository/scripts/live-idempotency.sh` runs
  against the real bucket over HTTPS
  (`https://events.dev.personal-events.fifthdimensionengineering.com.s3.us-west-2.amazonaws.com`),
  resolving credentials via the standard AWS chain.

**Production-write approval — GRANTED 2026-08-31. The question as asked and approved:**

> AWE-213 — S3 event repository & push CLI requires a live write to prove the idempotent
> conditional put (AC-07). May I push **two** test events (identical key, `source=selftest`,
> `name=acceptance-probe`, priority 1) to the development bucket
> `events.dev.personal-events.fifthdimensionengineering.com`? The objects are ~200 bytes each,
> land under the normal event prefix, and the script deletes them on completion. No other object
> is read, modified, or removed.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK

- **Layering** (ADR `2026-08-03-0028-layered-architecture`): this package is a **Repository**. No
  AWS SDK type may escape it — `PutObjectCommandOutput`, `S3ServiceException` and friends are
  translated to `PutOutcome` / `EventWriteError` at the boundary. Nothing above the Repository
  knows S3 exists.
- **Gather / Compute / Persist** (`.agents/general.md`):
  - *Gather* — `src/args.ts` (argv), `src/payload.ts` (file/stdin), `src/bucket.ts` (env);
  - *Compute* — `src/build-event.ts`, pure and total, returning `Either`; the codec call;
  - *Persist* — `src/put-event.ts` only.
  The compute step must **receive** its data as parameters and perform no I/O.
- **Effect vs Either** (`CLAUDE.md` one-line test): touches network/filesystem/clock/env →
  `Effect`. Pure but fallible → `Either`. `buildEvent` is `Either`; `put` is `Effect`. Raw
  `Promise` appears **only** in `main.ts` via `Effect.runPromise`.
- **No enums; `Record` lookups over `if`/`else if`** — the exit-code table and the
  error-tag→exit-code mapping are `Record` lookups, not chained conditionals.
- **No accumulator loops** — the argument matrix and validation-issue lists are built with
  `filter`/`map`/`flatMap`, never a mutable array filled in a `for` loop.
- **Module SRP** — one responsibility per file; do not let argv parsing and S3 wiring share a
  module because they were written in the same sitting.

### Files to read — READ THESE BEFORE IMPLEMENTING

- `.agents/plans/minimal-event-pipeline/core-layer-contracts.md` (AWE-153) — Why: the exact
  `EventRepository` `Context.Tag`, `PutOutcome` and `EventWriteError` shapes this story
  implements. **The contract is defined there; do not redefine it here.**
- `.agents/plans/minimal-event-pipeline/event-model-package.md` (AWE-150) — Why: `buildKey`,
  `parseKey`, `parseEvent`, and the exported field schemas `Priority`, `NoDotString`,
  `IsoInstant`. Re-declaring any of these forks the contract (a review gate on this feature).
- `.agents/plans/minimal-event-pipeline/monorepo-bootstrap.md` (AWE-149) — Why: the package
  scaffold shape (package.json/tsconfig/tsup.config) every workspace member mirrors.
- `.agents/plans/minimal-event-pipeline/infra-s3-and-dns.md` (AWE-151) — Why: the bucket naming
  convention and the `event_bucket_name` Terraform output that operators read to set
  `EVENT_BUCKET`.
- `CLAUDE.md` — Why: the binding stack table and the Effect-vs-Either one-line test.
- `.agents/tests.md` — Why: exemplars over mocks; the live-integration requirement.

### Files to create / change

- `packages/s3-repository/package.json` — `@personal-events/s3-repository`, private,
  `type: module`, `bin: { "event-push": "./dist/main.js" }`, deps `effect`,
  `@aws-sdk/client-s3`, `@personal-events/event-model`, `@personal-events/core`.
- `packages/s3-repository/tsconfig.json`, `tsup.config.ts` — mirror AWE-149; `dts: true`,
  ESM only, `banner: { js: "#!/usr/bin/env node" }` on the `main` entry so the `bin` is directly
  executable.
- `packages/s3-repository/src/args.ts` — `parseArgs` wrapper → `Either<ParsedArgs, UsageError>`.
- `packages/s3-repository/src/payload.ts` — read `--payload` file or stdin → `Effect`.
- `packages/s3-repository/src/bucket.ts` — pure precedence resolution
  (`--bucket` > `EVENT_BUCKET`) → `Either<string, UsageError>`.
- `packages/s3-repository/src/build-event.ts` — **pure**: `ParsedArgs → Either<Event, UsageError>`,
  applying `acknowledged: false`, `handled: false` and the timestamp default.
- `packages/s3-repository/src/put-event.ts` — the only AWS-aware module: `S3Client`, conditional
  `PutObjectCommand` with `IfNoneMatch: "*"`, exception→`EventWriteError`/`AlreadyExists`
  translation.
- `packages/s3-repository/src/repository.ts` — `S3EventRepositoryLayer`, the `Layer` satisfying
  core's `EventRepository` tag.
- `packages/s3-repository/src/exit-codes.ts` — the `Record<ErrorTag, number>` mapping.
- `packages/s3-repository/src/main.ts` — the `bin`: gather → compute → provide layer →
  `Effect.runPromise` → `process.exit`.
- `packages/s3-repository/src/*.spec.ts` — co-located unit tests.
- `packages/s3-repository/scripts/live-idempotency.sh` — the AC-07 live proof; `shellcheck`-clean.
- `packages/s3-repository/exemplars/` — valid and invalid payload JSON files.
- `packages/s3-repository/README.md` — flags, exit-code table, `EVENT_BUCKET`, and an explicit
  note that **AWE-162's CLI has the opposite exit contract**.

### Relevant documentation

- [S3 conditional writes (`If-None-Match`)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
  — Why: the mechanism behind AC-07; documents the `412 PreconditionFailed` response this story
  translates to `AlreadyExists`.
- [`@aws-sdk/client-s3` `PutObjectCommand`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/command/PutObjectCommand/)
  — Why: the `IfNoneMatch` input field and the error shapes to translate.
- [AWS SDK v3 default credential provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
  — Why: AC-06 forbids a hardcoded profile.
- [`node:util` `parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig)
  — Why: the dependency-free argv parser; note its `strict` and `allowPositionals` semantics.
- [Effect `Layer`](https://effect.website/docs/requirements-management/layers/) and
  [Services/Context](https://effect.website/docs/requirements-management/services/)
  — Why: implementing core's `Context.Tag` as a `Layer`.

### Patterns to follow

- **Repository layer implementing core's tag** — the implementation lives here, the contract does
  not:
  ```ts
  export const S3EventRepositoryLayer = Layer.effect(
    EventRepository,
    Effect.gen(function* () {
      const client = yield* makeClient
      return {
        put: (event: Event) => putEvent(client, bucket, event),
        putAll: (events: readonly Event[]) =>
          Effect.forEach(events, e => putEvent(client, bucket, e), { concurrency: 4 })
      }
    })
  )
  ```
- **Conditional put translation** — `AlreadyExists` is a success, not a failure:
  ```ts
  Effect.catchIf(
    (e: unknown) => isPreconditionFailed(e),
    () => Effect.succeed({ _tag: "AlreadyExists", key } as const)
  )
  ```
- **Exit codes as a `Record`, never a chained `if`** (per `typescript.md` Branch Selection):
  ```ts
  const exitCodes: Record<CliErrorTag, number> = {
    UsageError: 2,
    CredentialError: 3,
    BucketError: 4
  }
  ```
- **Import, never re-declare, the field schemas** — `import { Priority, NoDotString, IsoInstant }
  from "@personal-events/event-model"`. Re-declaring the 1–8 bound is the specific forking
  failure this feature's cross-story contract calls out.
- **Pure compute takes parameters** — `buildEvent(args: ParsedArgs, now: string)`: the clock is
  *passed in*, which is what makes the round-trip matrix deterministic.
- **Tests use real exemplars**, not hand-built objects, per `.agents/tests.md`; mocks appear only
  for the credential/network sad paths that cannot be provoked with a real bucket.

### Codebase irregularities to ignore

- **The stub's "does not need AWE-153" note is stale** — see Notes. AWE-153 defines the contract
  this story implements.
- **The stub referred to `@personal-events/s3-push` (AWE-160) as a swap target.** AWE-160 is
  **abandoned**; there is nothing to be a drop-in for. The stable seam is core's `EventRepository`
  tag, which AC-02 targets instead.
- **`tsup`, not `tsdown`.** `node/preferences.md` mentions tsdown, but `CLAUDE.md` and every
  sibling story pin tsup. Follow tsup.
- **winston appears in several older plan files.** It belongs to the non-Effect branch of
  `node/preferences.md` and must not be introduced here.

### Step-by-step tasks

Execute in order.

#### CREATE packages/s3-repository scaffold
- **IMPLEMENT**: package.json (with `bin`), tsconfig, tsup.config with the shebang banner.
- **PATTERN**: AWE-149's package scaffold; AWE-150's `packages/event-model` layout.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository build` emits `dist/main.js`.

#### CREATE src/args.ts, src/bucket.ts — the gather + precedence layer
- **IMPLEMENT**: `parseArgs`-based parsing returning `Either<ParsedArgs, UsageError>`; bucket
  precedence `--bucket` > `EVENT_BUCKET` with an error naming both.
- **GOTCHA**: `parseArgs` throws on unknown options in `strict` mode — catch and translate to a
  typed `UsageError` rather than letting it escape.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository test -- bucket-precedence`

#### CREATE src/build-event.ts — pure compute
- **IMPLEMENT**: `ParsedArgs → Either<Event, UsageError>`; defaults `acknowledged: false`,
  `handled: false`; timestamp from the injected clock or `--timestamp`; validate via
  `parseEvent` from `event-model`.
- **GOTCHA**: import `Priority`/`NoDotString`/`IsoInstant`; do not restate the 1–8 bound.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository typecheck`

#### CREATE src/put-event.ts + src/repository.ts — the persist boundary
- **IMPLEMENT**: `PutObjectCommand` with `IfNoneMatch: "*"`; translate `412` →
  `AlreadyExists`, credential/access errors → `EventWriteError`; expose
  `S3EventRepositoryLayer` satisfying core's tag.
- **GOTCHA**: no AWS SDK type may appear in an exported signature (ADR layering).
- **VALIDATE**: `! rg -n '@aws-sdk' packages/s3-repository/src --glob '!put-event.ts' --glob '!*.spec.ts'`

#### CREATE src/exit-codes.ts + src/main.ts — the bin
- **IMPLEMENT**: `Record` mapping of error tag → exit code; `main.ts` wires gather → compute →
  layer → `Effect.runPromise`; `--dry-run` short-circuits before providing the layer.
- **GOTCHA**: `--dry-run` must not construct an `S3Client` at all — constructing one can itself
  fail on bad config and would violate AC-08's "zero network calls" in spirit.
- **VALIDATE**: `node packages/s3-repository/dist/main.js --type alert --priority 5 --source cron --name backup-failed --bucket x --dry-run` exits 0 and prints a key.

#### CREATE the failure-mode table test (13 cases)
- **IMPLEMENT**: a table-driven vitest suite covering the complete AC-10 inventory, asserting the
  exact exit code per case, plus a guard asserting the table length equals the documented count.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository test -- failure-modes`

#### CREATE the round-trip matrix test
- **IMPLEMENT**: dotted `source`/`name`, priorities 1 and 8, missing optional `workItem`; assert
  `parseKey(buildKey(e))` equals the components; include a wrong-segment-count negative case.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository test -- key-round-trip`

#### CREATE scripts/live-idempotency.sh — the live production proof
- **IMPLEMENT**: push the same event twice against the dev bucket; assert `Created` then
  `AlreadyExists`, assert `LastModified` unchanged, then delete the probe object.
- **GOTCHA**: requires AWE-151 applied and explicit production-write approval.
- **VALIDATE**: `shellcheck packages/s3-repository/scripts/live-idempotency.sh`

#### WRITE README with the exit-code table and the opposite-contract warning
- **IMPLEMENT**: flags, exit codes, `EVENT_BUCKET`, and the explicit AWE-162 contrast.
- **VALIDATE**: `rg -q 'AWE-162' packages/s3-repository/README.md`

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: reconcile against `.agents/general.md` + `typescript.md`: G-C-P boundaries
  intact, no accumulator loops, `Record` over `if`/`else`, no enums, explicit return types.
- **VALIDATE**: `pnpm --filter @personal-events/s3-repository exec biome check src` and
  `pnpm --filter @personal-events/s3-repository typecheck` clean.

### Testing strategy

- **Unit (vitest + `@effect/vitest`)**: `args`, `bucket` precedence, `build-event` (valid,
  invalid, defaults, timestamp override), key round-trip matrix, exit-code table. Pure modules
  need no mocks.
- **Integration (live, production)**: `scripts/live-idempotency.sh` against
  `events.dev.personal-events.fifthdimensionengineering.com` over HTTPS, credentials via the
  default chain. **This is a production write** and is gated on the approval question above.
  A read-only variant (`head-object` on a known key) runs unconditionally under execute's
  automatic read authorization.
- **Edge cases**: dotted `source`/`name`; priority 0/1/8/9; empty stdin; malformed payload JSON;
  expired credentials; non-existent bucket; identical re-push.
- **Skip inventory**: the live write test is the **only** conditionally-run suite, gated on
  approval plus credentials. It is enumerated here explicitly; if it does not run, the story is
  **blocked**, not passed. Expected unexpected-skip count is **0**.

### Validation commands

- Level 1 — Syntax & style: `pnpm --filter @personal-events/s3-repository exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/s3-repository typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/s3-repository test`
- Level 4 — Live: `bash packages/s3-repository/scripts/live-idempotency.sh` and
  `shellcheck packages/s3-repository/scripts/*.sh`
