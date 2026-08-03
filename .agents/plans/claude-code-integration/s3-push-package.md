---
id: AWE-160
title: Shared S3 event writer (@personal-events/s3-push)
type: story
status: ready
parent: ./feature.md
branch: feat/claude-code-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-06-29
---

# Story: Shared S3 event writer (@personal-events/s3-push)

## Definition

### User story
As a developer building any event producer in this system (the Claude hook CLI now; the GitHub
webhook handler/poller and Slack client later)
I want a single shared package that takes a canonical `Event` and writes it to the S3 event
bucket as a correctly-named object
So that the "build the object key → PutObject" logic exists exactly once and every producer
writes events identically and idempotently.

### Acceptance criteria
- A new workspace package `@personal-events/s3-push` (private, `private: true`, not published)
  builds, lints, and tests under the monorepo toolchain.
- It exposes a write-only API that, given a canonical `Event` (from `@personal-events/event-model`)
  and a target bucket, builds the `{timestamp}.{type}.{priority}.{source}.{name}.json` object key
  **via the event-model key codec** (not a re-implemented string template) and `PutObject`s the
  serialized event.
- The S3 client uses the **AWS SDK v3 default credential chain** (ambient creds / profile / SSO /
  instance role) — no creds are read or passed as plaintext by this package.
- **Idempotent:** writing the same key twice does not create a duplicate and does not throw a
  hard error — implemented via a conditional put (`If-None-Match: "*"`) or equivalent, with the
  "already exists" case surfaced as a benign typed result, not an exception.
- Results are **typed** (`Either` / object result types per `.agents/general.md`) — success
  carries the written object key; failure carries a typed cause (auth, not-found/denied,
  serialization, conflict). The package is the **Persist** boundary in G-C-P terms and contains
  no classification/transform logic.
- Failure modes return typed errors rather than crashing: missing/invalid credentials, bucket
  unreachable or access denied, and a serialization failure.
- Unit tests cover key-building correctness (round-trips with the event-model codec), the
  idempotent-conflict path, and error mapping, with the S3 client mocked (no live AWS in tests).
- Guidance conformance pass (G-C-P/Persist boundary, module SRP, no enums, typed results),
  verified by `biome` + `typecheck`.

### Notes / Open questions
- Decide the precise public surface: a free function `pushEvent(client, bucket, event)` vs a thin
  `S3EventWriter` wrapper holding the client + bucket. Lean functional per `general.md` unless a
  handle is clearly better for reuse.
- Decide whether `s3-push` owns construction of the `S3Client` or always receives one (prefer
  receiving it so callers control region/endpoint/creds; offer a small default factory if useful).
- Idempotency mechanism: confirm `If-None-Match` conditional `PutObject` semantics vs a
  `HeadObject`-then-put (the conditional put avoids a race and an extra call).
- This is the rule-of-three extraction; the GitHub/Slack runtime stories should later consume it
  rather than re-implementing — coordinate that update against AWE-156/157/159.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This package is
> the **Persist boundary** every producer shares — it must be a thin, total, well-typed wrapper
> around one `PutObject`, with **no** classification/transform logic (that is `integration-core`'s
> job) and **no** logging (callers log from the typed result). Do not restate the user story here.

### Decisions resolved during planning (open questions answered)
- **Public surface: a free function** `pushEvent(client, bucket, event): Promise<PushResult>`
  (functional per `general.md`), plus an optional convenience factory `createEventS3Client(region?)`.
  The caller owns the `S3Client` (region/endpoint/creds) and passes it in (slice-don't-dump: pass
  the live handle, not a config snapshot) — this is the one allowed "pass the whole handle" case.
- **Idempotency: conditional `PutObject` with `IfNoneMatch: "*"`** (NOT `HeadObject`-then-put — the
  conditional put is atomic and avoids the check-then-act race). S3 launched this Aug 2024; SigV4
  (SDK v3 default) is required and automatic. A precondition failure means the key already exists →
  return a **benign** `AlreadyExists` result, not an error.
- **Result type: a discriminated union on `_tag`** (effect convention, per `general.md` Return
  Values), `Promise<PushResult>` — `{ _tag: "Created" | "AlreadyExists", key }` for the two
  non-error outcomes, and `{ _tag: "Failure", key, reason, cause }` for failures, where `reason`
  is a closed `as const` set selected via a `Record` lookup (no if/else chains). No throwing out of
  `pushEvent`; the only `throw` is re-raised truly-unexpected non-Error values.
- **Serialization: encode through the schema** — `JSON.stringify(Schema.encodeSync(EventSchema)(event))`
  so the stored object is the canonical *Encoded* wire shape (e.g. `workItem` URL → string), not the
  in-memory `Type`. `ContentType: "application/json"`.
- **`@personal-events/*` deps stay external** in this package (it is a library consumed *within* the
  monorepo; only the published CLI in AWE-162 bundles them). `tsdown` `dts: true`, deps default
  (event-model external).

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md and .agents/languages/typescript/typescript.md. -->
- **Gather / Compute / Persist** (`general.md`): this package is **Persist only**. It receives a
  fully-formed `Event` (Compute already done upstream) and side-effects S3. No fetching, no
  classification, no mapping config here.
- **Module-level SRP** (`general.md`): split `result.ts` (the `PushResult` types + `reason` set +
  the error→reason `Record`), `error-classify.ts` (the pure `classifyError(err) → reason`),
  `event-writer.ts` (the `pushEvent` Persist function), `client.ts` (the optional `S3Client`
  factory), `index.ts` (public re-exports). Each has one axis of change.
- **Return Values / Objects** (`typescript.md`): explicit return types everywhere; no bare
  `null`/`undefined`; the `_tag` discriminated union is the result contract. `async` keyword on the
  promise-returning `pushEvent`.
- **No enums** (`typescript.md`): the `reason` set is an `as const` object →
  `type PushFailureReason = typeof pushFailureReasons[keyof typeof pushFailureReasons]`.
- **Branch selection via `Record`** (`typescript.md`): map the derived error discriminator to a
  `reason` through a `Record`, not an `if/else if` chain. The minimal predicate logic that *derives*
  the discriminator (is-it-an `S3ServiceException`, is there `$metadata`) is genuine predicate logic
  and may use `if/else` — but the name→reason selection is a `Record`.
- **No accumulator loops** (`typescript.md`): none expected; tests use table-driven `it.each`.
- **No logging in the library** (`logging.md` / `general.md`): return typed results; the CLN/caller
  logs. (The CLI in AWE-162 does the winston logging from the `PushResult`.)
- **TS house style**: no semicolons, double quotes, width 140, arrow functions, `.ts` relative
  imports — all enforced by the root biome/tsconfig from AWE-149.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/bootstrap-and-iac/event-model-package.md` (the whole Plan) — Why: the **exact
  upstream contract** this package consumes — `EventSchema`, `Event`/`EventEncoded` types,
  `buildKey(event)`, and that `source`/`name` are already no-dot-validated so `buildKey` is total
  for a valid `Event`.
- `.agents/languages/typescript/typescript.md` (Return Values, Enums, Branch Selection, Async) —
  Why: the result-type, no-enum, `Record`-lookup, and `async` rules this package must follow.
- `.agents/languages/typescript/typescript-testing.md` and `.agents/tests.md` — Why: co-located
  `*.spec.ts`, happy + sad paths, **mocking is a last resort** allowed for failure-case S3 paths
  that cannot be exercised with a real fixture; real-bucket integration test gated on env.
- `.agents/guidance/aws.md` — Why: project AWS conventions (S3 default no versioning/replication;
  this package assumes the bucket exists, provisioned by AWE-151).
- `.agents/general.md` (Gather/Compute/Persist, SRP at module level) — Why: the Persist-boundary
  framing that defines this package's scope.
- `.agents/plans/bootstrap-and-iac/monorepo-bootstrap.md` (Files to create, Patterns) — Why: the
  package scaffolding shape (tsconfig extends base, per-package vitest `defineProject`, catalog
  versions) to mirror.

### Files to create / change
- `packages/s3-push/package.json` — `@personal-events/s3-push`, `private: true`, `type: module`;
  `dependencies`: `@aws-sdk/client-s3`, `effect`, `@personal-events/event-model` (`workspace:*`);
  `devDependencies`: `tsdown`, `vitest`, `typescript`, `aws-sdk-client-mock`,
  `aws-sdk-client-mock-jest` (catalog versions); scripts `build`/`test`/`typecheck`/`lint`.
- `packages/s3-push/tsconfig.json` — extends `../../tsconfig.base.json`; `composite: true`,
  `outDir: dist`, `rootDir: src`.
- `packages/s3-push/tsdown.config.ts` — `entry: ["src/index.ts"]`, `format: ["esm"]`,
  `platform: "node"`, `target: "node24"`, `dts: true`, `clean: true` (defaults, but explicit).
  **Do NOT** add `deps.alwaysBundle` — event-model stays external for a library.
- `packages/s3-push/vitest.config.ts` — `defineProject` with a unique `name: "s3-push"`.
- `packages/s3-push/src/result.ts` — `pushFailureReasons` (`as const`), `PushFailureReason`,
  `PushCreated`/`PushAlreadyExists`/`PushFailure`/`PushResult` types.
- `packages/s3-push/src/error-classify.ts` — pure `classifyError(err: unknown): PushFailureReason`.
- `packages/s3-push/src/event-writer.ts` — `pushEvent(client, bucket, event): Promise<PushResult>`.
- `packages/s3-push/src/client.ts` — `createEventS3Client = (region?: string): S3Client`.
- `packages/s3-push/src/index.ts` — re-export the public surface.
- `packages/s3-push/src/event-writer.spec.ts` — unit tests via `aws-sdk-client-mock`.
- `packages/s3-push/src/error-classify.spec.ts` — table-driven error→reason tests.
- `packages/s3-push/src/event-writer.integration.spec.ts` — **optional**, gated on
  `AWE_TEST_BUCKET` env (skipped when unset); writes to a real bucket and asserts the
  `Created`→`AlreadyExists` idempotency round-trip.

### Relevant documentation
- [S3 conditional writes (`If-None-Match`)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
  — Why: the idempotent-put semantics; launched Aug 2024, SigV4 required (SDK v3 default).
- [PutObjectCommand API](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Class/PutObjectCommand/)
  — Why: `Bucket`/`Key`/`Body`/`ContentType`/`IfNoneMatch` input fields.
- [AWS SDK v3 credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
  — Why: `new S3Client({})` resolves env→SSO→profile→ECS→IMDS automatically; region via
  `AWS_REGION`/profile/explicit.
- [aws-sdk-js-v3 ERROR_HANDLING.md](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/ERROR_HANDLING.md)
  — Why: `S3ServiceException` base, `$metadata.httpStatusCode`, error `name` discrimination.
- [aws-sdk-client-mock](https://github.com/m-radzikowski/aws-sdk-client-mock) — Why: the
  `mockClient(S3Client)` + `aws-sdk-client-mock-jest/vitest` matcher approach for unit tests.
- [effect Schema encode](https://effect.website/docs/schema/getting-started/) — Why:
  `Schema.encodeSync(EventSchema)` to produce the canonical wire shape before `JSON.stringify`.

### Patterns to follow
- **`pushEvent` (the Persist function):**
  ```ts
  import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
  import { Schema } from "effect"
  import { EventSchema, buildKey, type Event } from "@personal-events/event-model"

  export const pushEvent = async (client: S3Client, bucket: string, event: Event): Promise<PushResult> => {
    const key = buildKey(event)
    const body = JSON.stringify(Schema.encodeSync(EventSchema)(event))
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", IfNoneMatch: "*" }))
      return { _tag: "Created", key }
    } catch (cause) {
      const reason = classifyError(cause)
      return reason === "conflict-already-exists" ? { _tag: "AlreadyExists", key } : { _tag: "Failure", key, reason, cause }
    }
  }
  ```
- **`classifyError` (pure, minimal predicates + Record):** detect client-side
  `CredentialsProviderError` (no `$metadata`) → `"credentials"`; for `S3ServiceException`, map
  `err.name` through a `Record` (`PreconditionFailed`→`conflict-already-exists`,
  `NoSuchBucket`→`no-such-bucket`, `AccessDenied`→`access-denied`) with httpStatus 409 →
  `"conflict-race"`; default `"unknown"`. (`NoSuchBucket` is a typed class importable from
  `@aws-sdk/client-s3`; `AccessDenied`/`PreconditionFailed` are matched by `.name` — they are not
  exported classes.)
- **`reason` set (`as const`, no enum):**
  ```ts
  export const pushFailureReasons = {
    credentials: "credentials", noSuchBucket: "no-such-bucket", accessDenied: "access-denied",
    conflictRace: "conflict-race", serialization: "serialization", unknown: "unknown",
  } as const
  ```
  (`conflict-already-exists` is handled before `Failure`, so it is not a *failure* reason.)
- **Unit test (mock):** `const s3 = mockClient(S3Client)` in `beforeEach(() => s3.reset())`;
  `s3.on(PutObjectCommand).resolves({})` for success; reject with an object whose `name` is
  `"PreconditionFailed"` and `$metadata.httpStatusCode: 412` for the idempotency path; assert
  `toHaveReceivedCommandWith(PutObjectCommand, { Bucket, Key, IfNoneMatch: "*" })`.

### Codebase irregularities to ignore
- **Bundler:** AWE-149 and the event-model plan say "tsup" / "do not introduce tsdown". For THIS
  feature the user has decided to use **tsdown** (the maintained successor; tsup is soft-deprecated).
  Use `tsdown` here. The cross-feature inconsistency is tracked as an open item (see feature report)
  — do not "fix" it by reverting to tsup.
- tsdown defaults differ from tsup: `format` defaults to **esm**, `clean` defaults to **true**, and
  `dts` auto-enables from `types`/`declaration` — the explicit config above is for clarity.
- Effect Schema lives in the **`effect`** package (`import { Schema } from "effect"`); ignore any
  `@effect/schema` standalone-package references (merged into core at 3.10).

### Step-by-step tasks
Execute in order.

#### CREATE packages/s3-push scaffold
- **IMPLEMENT**: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts` per the
  files list; add `tsdown` to the workspace catalog if AWE-149 hasn't already.
- **PATTERN**: mirror a built package from AWE-149/AWE-150; `@personal-events/*` deps external.
- **GOTCHA**: tsdown needs Node ≥22.18 to *run* (fine on Node 24); output targets node24.
- **VALIDATE**: `pnpm --filter @personal-events/s3-push build` (emits `dist` + `.d.ts`).

#### CREATE src/result.ts + src/error-classify.ts
- **IMPLEMENT**: the `pushFailureReasons` `as const`, the `PushResult` union, and the pure
  `classifyError`; select reasons via a `Record`, not chained `if/else`.
- **PATTERN**: Return Values / Branch Selection in `typescript.md`; error taxonomy from research.
- **GOTCHA**: `CredentialsProviderError` is client-side with **no** `$metadata` — detect it before
  touching `$metadata.httpStatusCode`.
- **VALIDATE**: `pnpm --filter @personal-events/s3-push typecheck`.

#### CREATE src/event-writer.ts + src/client.ts + src/index.ts
- **IMPLEMENT**: `pushEvent` (conditional put, encode-then-stringify) and the `createEventS3Client`
  factory; re-export the public surface from `index.ts`.
- **PATTERN**: the `pushEvent` snippet above; `buildKey`/`EventSchema` from event-model.
- **GOTCHA**: encode via `Schema.encodeSync(EventSchema)` so the *Encoded* wire shape is stored;
  never `JSON.stringify` the in-memory `Type` directly.
- **VALIDATE**: `pnpm --filter @personal-events/s3-push typecheck`.

#### CREATE unit specs (mocked S3)
- **IMPLEMENT**: `error-classify.spec.ts` (table-driven name/status → reason) and
  `event-writer.spec.ts` (Created success asserting the `IfNoneMatch: "*"` input; AlreadyExists on
  412; Failure on NoSuchBucket/AccessDenied/credentials).
- **PATTERN**: `aws-sdk-client-mock` + `import "aws-sdk-client-mock-jest/vitest"` matchers.
- **GOTCHA**: build the rejected error with `name` set explicitly (`Object.assign(new
  S3ServiceException({...}), { name: "PreconditionFailed" })`) — the mock rejects with the value
  verbatim.
- **VALIDATE**: `pnpm --filter @personal-events/s3-push test`.

#### CREATE optional integration spec (real bucket, env-gated)
- **IMPLEMENT**: `event-writer.integration.spec.ts` using `describe.skipIf(!process.env.AWE_TEST_BUCKET)`;
  build a valid `Event`, `pushEvent` twice, assert `Created` then `AlreadyExists`; clean up the
  object in `afterAll`.
- **PATTERN**: `.agents/tests.md` real-API mandate — exercised when creds + a throwaway bucket exist.
- **VALIDATE**: with `AWE_TEST_BUCKET`/`AWS_REGION` set,
  `pnpm --filter @personal-events/s3-push test` runs it; unset, it is skipped (still green).

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: dedicated pass against `general.md` + `typescript.md`: (1) module SRP — each file
  one axis of change; (2) Persist-only — no classification/logging leaked in; (3) `Record` lookup
  for reason selection; (4) explicit return types, `async` on `pushEvent`, arrow functions; (5) no
  enums, no accumulator loops.
- **VALIDATE**: `pnpm --filter @personal-events/s3-push exec biome check src` and `typecheck`
  clean; optionally `/simplify` the diff.

### Testing strategy
- **Unit**: pure `classifyError` table; `pushEvent` with `aws-sdk-client-mock` covering Created,
  AlreadyExists (412), and each Failure reason (NoSuchBucket 404, AccessDenied 403, credentials).
  Mocking is justified here per `.agents/tests.md` (sad-path S3 outcomes not reproducible with a
  fixture, and S3 is not locally fixture-able).
- **Integration**: optional real-bucket spec gated on `AWE_TEST_BUCKET` — proves the conditional
  put + credential chain against live S3 and the idempotency round-trip.
- **Edge cases**: 409 concurrent-delete race → `conflict-race` (distinct from 412 AlreadyExists);
  malformed `Event` that fails `Schema.encodeSync` → `serialization` Failure (no crash).

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @personal-events/s3-push exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/s3-push typecheck`
- Level 3 — Unit: `pnpm --filter @personal-events/s3-push test`
- Level 4 — Integration (optional): `AWE_TEST_BUCKET=… AWS_REGION=… pnpm --filter @personal-events/s3-push test`
  and confirm a sibling package can `import { pushEvent, createEventS3Client } from "@personal-events/s3-push"`.
