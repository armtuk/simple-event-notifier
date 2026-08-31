---
id: AWE-162
title: Publishable hook CLI (@alexrmturner/claude-events)
type: story
status: todo:backlog
parent: ./feature.md
branch: feat/claude-code-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-08-03
---

# Story: Publishable hook CLI (@alexrmturner/claude-events)

> **Restructured 2026-08-03.** Writes through F1's `@personal-events/s3-repository` (AWE-213); AWE-160 was abandoned. The code sketches in `## Plan` were converted from `Promise` to `Effect` on 2026-08-03 per ADR `2026-08-03-0035-effect-as-default-idiom`. Re-run `/plan-story` before executing.

## Definition

### User story
As a Claude Code user on any of my machines (desktop, laptop, servers)
I want a single installable command that a Claude Code hook can invoke to push the session event
to S3
So that "prompt complete" / "agent needs me" show up in my event bus everywhere I run Claude
Code, without standing up infrastructure and without slowing down or breaking a turn.

### Acceptance criteria
- A CLI package `@alexrmturner/claude-events` exposes a `bin` that **reads the hook JSON from
  stdin** (the Claude Code hook contract) and also accepts `--file <path>` for replay/testing.
- It composes the other packages: validate + classify via `@personal-events/claude-code`
  (AWE-161) through `integration-core.transform`, then write via `@personal-events/s3-push`
  (AWE-160). It contains **only composition + process concerns** — no classification or
  key-building logic of its own.
- **No turn latency:** the upload is detached/fire-and-forget so the hook command returns
  effectively instantly; the chosen detach mechanism reliably completes the write (no silently
  dropped events). If a synchronous write is chosen instead, the added latency is demonstrably
  imperceptible at the expected event rate.
- **Never breaks the session:** any failure (missing/invalid AWS creds, unreachable/denied
  bucket, malformed/unknown payload) is logged to **stderr** and the process **exits 0**; the CLI
  never throws an unhandled error or blocks the hook. Bucket name and region come from env/flags
  with documented defaults.
- **Idempotent end-to-end:** replaying the same hook delivery does not double-write to S3 (relies
  on the event-identity from AWE-161 + the idempotent put from AWE-160).
- **Installable anywhere:** the package is bundled self-contained with `tsdown` (the private
  `@personal-events/*` deps inlined) and **published to npm** under the `@alexrmturner` scope;
  `npx @alexrmturner/claude-events` (or a global install) runs on a machine with no monorepo
  checkout.
- **Documented wiring:** a README + copy-pasteable `settings.json` hook recipe maps the relevant
  hook events (`Stop`, `Notification`, and optionally `SubagentStop`/`SessionStart`/`SessionEnd`)
  to invoke the bin, and documents the AWS credential expectation (profile/SSO; least-priv
  `s3:PutObject` to the bucket) and the bucket/region env vars.
- A short **ADR** records the direct-CLI decision (vs webhook ingest vs local daemon) and the
  `s3-push` extraction.
- Guidance conformance pass (thin composition layer, module SRP, typed results surfaced from the
  packages, no enums), verified by `biome` + `typecheck`.

### Notes / Open questions
- **Detach reliability** is the central design call: `spawn` detached + `unref`, a double-fork/
  `nohup`, or a short synchronous write. Validate that the write actually completes after the hook
  process exits (a naive background child can be reaped with the process group).
- Decide the publish/release mechanism (manual `npm publish` vs a release script/CI) and how the
  bundled `event-model` contract version is tracked when cutting releases.
- Confirm the Claude Code hook config surface (which events block vs are advisory, timeout
  behavior) so the recipe sets sensible per-event wiring.
- Consider a `--dry-run` / `--print` mode that emits the canonical event to stdout without writing
  S3, for users to verify classification before enabling live writes.
- Confirm the npm `@alexrmturner` scope exists / can be created and that publish auth is available.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This is the **thin
> composition layer** — `Gather` (read stdin/file), `Compute` (decode → normalize → transform, all
> from AWE-161 + integration-core), `Persist` (AWE-160's `pushEvent`) — plus process hygiene
> (always exit 0, log to stderr) and distribution (tsdown bundle + npm publish + hook recipe). It
> must contain **no** classification or key logic of its own. Do not restate the user story.

### Decisions resolved during planning (open questions answered)
- **Detach: solved by Claude Code's native `"async": true` hook flag** (research-confirmed) — NOT a
  `spawn`/`unref` dance. The `settings.json` recipe sets `"async": true` so Claude Code itself runs
  the hook in the background and the session returns immediately. The CLI therefore does a plain
  `await pushEvent(...)` and is simple/testable. As a fallback for users who don't set `async`, a
  ~100–300ms `PutObject` on `Stop` (which fires *after* the turn is already rendered) is
  imperceptible at a few events/min. **Do not implement a detached child process.**
- **Always exit 0**: the bin wraps everything in a top-level catch; every outcome (success,
  `AlreadyExists`, validation failure, S3 failure, missing creds) logs an appropriate line to
  stderr and calls `process.exit(0)`. Exit 2 would *block/alter* the Claude turn (per the hook
  contract) — we never want that. (Unknown hook events are classified by the default rule, also not
  an error.)
- **Config**: bucket from `--bucket` flag else `AWE_EVENT_BUCKET` env; region from `AWS_REGION`
  (SDK default). A missing bucket config logs and exits 0 (no crash).
- **`--dry-run` / `--print`**: build the canonical `Event` and print it (the JSON + the would-be S3
  key from `buildKey`) to stdout, skip the S3 write. For verifying classification before going live.
- **Placement & publish**: lives at `apps/claude-events/` (it is a runnable, end-user artifact and
  the **one published** workspace member). Published under `@alexrmturner` scope with
  `publishConfig.access: "public"`. The private `@personal-events/*` deps are **bundled** by tsdown
  (`deps.alwaysBundle`) so the published tarball is self-contained; `@aws-sdk/client-s3` + `effect`
  stay **external** (in `dependencies`) — they install once and Node module-caches them (no value in
  bundling the ~18 MB SDK).
- **Hook invocation: recommend a global install** (`npm i -g @alexrmturner/claude-events`) over raw
  `npx` in the recipe — `npx` revalidates against the registry on every call (~300ms even when
  cached), which is wasteful for a per-turn hook. Document a pinned-version `npx --yes …@x.y.z`
  fallback for machines where a global install is inconvenient.
- **Idempotency (honest scope)**: the CLI stamps `timestamp = now` (no event timestamp exists in the
  hook payload), so the S3 key is timestamp-led and a *later* replay produces a *new* key. The
  guarantee delivered is: a re-invocation that produces the **same key** is a benign `AlreadyExists`
  (via AWE-160's `IfNoneMatch`), and hooks fire once per delivery. The `eventId` from AWE-161 is
  carried in the event payload for downstream dedupe. Document this; do not over-claim cross-time
  dedupe.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md, typescript.md, node/preferences.md, logging.md. -->
- **Gather / Compute / Persist** (`general.md`): `read-payload.ts` = Gather; `run.ts` orchestrates
  Compute (AWE-161 decode/normalize + integration-core transform) → Persist (AWE-160 `pushEvent`);
  `cli.ts` = the process shell (argv, exit codes). Keep each phase in its own module.
- **Module-level SRP** (`general.md`): `cli.ts` (entry/argv/exit), `read-payload.ts` (stdin/file
  Gather), `run.ts` (the GCP composition returning a typed `RunResult`), `config.ts` (bucket/region
  resolution), `logger.ts` (winston default logger), `index.ts` (entry re-export for the bin).
- **Return Values** (`typescript.md`): `run(...)` returns a typed `RunResult` discriminated union
  (`Ingested` | `Skipped` | `ValidationFailed` | `WriteFailed` | `Misconfigured`); `cli.ts` maps
  each to a stderr log line via a `Record` and always exits 0.
- **Logging** (`logging.md` + `node/preferences.md`): use **winston**; emit well-formed JSON to
  stderr with `level`/`timestamp`/`service: "claude-events"`/`env` (from `ENV`). Error logs include
  the offending value (truncated) + what was expected. The library packages do not log — the CLI
  does, from their typed results.
- **No enums / Record branch-selection** (`typescript.md`): `RunResult._tag` → log-line mapping is a
  `Record`, not an if/else chain.
- **Async** (`typescript.md`): `run`, `readPayload`, and the bin's main are `async`.
- **TS house style**: no semicolons, double quotes, width 140, arrow functions, `.ts` imports.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/claude-code-integration/s3-push-package.md` (AWE-160) — Why: `pushEvent` signature
  + `PushResult` union the CLI logs from, and `createEventS3Client`.
- `.agents/plans/claude-code-integration/claude-code-event-mapping.md` (AWE-161) — Why:
  `decodeHookEvent`, `normalize`, `claudeCodeConfig`, and the normalized→transform input shape.
- **`@personal-events/integration-core` actual exports** — Why: `transform(config, normalized) →
  Event | Either<Event, error>` is the Compute step the CLI calls.
- `.agents/guidance/adr.md` — Why: the ADR format/structure for the decision record this story ships.
- `.agents/guidance/logging.md` and `.agents/code-examples/typescript/src/util/logger.ts` — Why: the
  winston per-destination logger pattern (JSON to the machine stream, readable to TTY).
- The **Claude Code hooks reference** (https://code.claude.com/docs/en/hooks) and the AWE-161
  research notes — Why: the `settings.json` structure, `"async": true`, `"timeout"`, matcher support
  (Notification matches `notification_type`; Stop has no matcher), and exit-code semantics.
- `.agents/plans/minimal-event-pipeline/monorepo-bootstrap.md` (AWE-149) — Why: workspace layout (`apps/*`), how a
  member joins turbo, catalog versions.

### Files to create / change
- `apps/claude-events/package.json` — `@alexrmturner/claude-events`, `type: module`,
  `bin: { "claude-events": "./dist/cli.mjs" }`, `files: ["dist"]`, `exports: { ".": "./dist/cli.mjs" }`,
  `engines: { node: ">=24.0.0" }`, `publishConfig: { access: "public" }`;
  `dependencies`: `@aws-sdk/client-s3`, `effect`;
  `devDependencies`: `@personal-events/s3-push`, `@personal-events/claude-code`,
  `@personal-events/event-model`, `@personal-events/integration-core` (all `workspace:*`, bundled),
  `tsdown`, `vitest`, `typescript`, `winston`; scripts `build`/`test`/`typecheck`/`lint` +
  `postbuild: "chmod +x dist/cli.mjs"`.
- `apps/claude-events/tsconfig.json` — extends base.
- `apps/claude-events/tsdown.config.ts` — `entry: ["src/cli.ts"]`, `format: ["esm"]`,
  `platform: "node"`, `target: "node24"`, `dts: false`, `fixedExtension: true` (→ `.mjs`),
  `outputOptions: { banner: "#!/usr/bin/env node\n" }`,
  `deps: { alwaysBundle: [/^@personal-events\//], neverBundle: ["@aws-sdk/client-s3", "effect"] }`.
- `apps/claude-events/src/cli.ts` — the bin entry and **the only place a `Promise` exists**: parse
  argv (`--file`, `--dry-run`/`--print`, `--bucket`, `--region`), then
  `Effect.runPromiseExit(run(args).pipe(Effect.provide(AppLayer)))`, map the `Exit` → stderr log,
  `process.exit(0)` unconditionally.
- `apps/claude-events/src/read-payload.ts` — `readPayload(argv): Effect<string, NoInputError>`
  (file via `--file`, else slurp `process.stdin`, with `process.stdin.isTTY` guard).
- `apps/claude-events/src/run.ts` — `run(input): Effect<RunResult, never, S3EventRepository>`
  composing decode → normalize → `transform` → push (or the `--dry-run` print path). **`E` is
  `never` by construction** — every failure is folded into a `RunResult` tag, which is what makes
  the exit-0 contract structural rather than a discipline.
- `apps/claude-events/src/result.ts` — `RunResult` union + the `_tag` → log mapping `Record`.
- `apps/claude-events/src/config.ts` — resolve bucket (`--bucket`|`AWE_EVENT_BUCKET`) + region.
- `apps/claude-events/src/logger.ts` — winston default logger (`service: "claude-events"`, JSON to
  stderr, `env` from `ENV`).
- `apps/claude-events/README.md` — install (global + npx fallback), the `settings.json` recipe with
  `"async": true`, the AWS credential expectation + least-priv IAM policy, env vars, and the
  event→classification table (pointing at AWE-161's config).
- `apps/claude-events/docs/adr/0001-claude-code-direct-cli-ingest.md` — ADR per `.agents/guidance/adr.md`.
- specs: `read-payload.spec.ts`, `run.spec.ts`; optional `cli.integration.spec.ts` (env-gated).

### Relevant documentation
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) — `settings.json` schema,
  `"async"`/`"timeout"`, matcher support, exit codes (2 blocks/alters the turn — avoid).
- [tsdown CLI/bin (shebang via `outputOptions.banner`)](https://tsdown.dev/) and
  [tsdown deps (`alwaysBundle`/`neverBundle`)](https://tsdown.dev/options/dependencies) — Why: the
  self-contained bundle config; `fixedExtension` → `.mjs`; chmod via postbuild.
- [npm scoped public packages (`publishConfig.access`)](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
  — Why: scoped packages default to restricted; `access: "public"` is required.
- [AWS SDK v3 credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
  — Why: the credential/region expectation to document for users.
- Node stdin async iteration (`for await (const chunk of process.stdin)`) and `process.stdin.isTTY`
  guard — Why: robust payload reading + a clear "no input" error.

### Patterns to follow
- **`readPayload`:** `--file <path>` → read the file; else if `process.stdin.isTTY` → return a typed
  "no input" outcome (don't hang); else slurp stdin via `for await`. (See AWE research snippet.)
- **`run` (GCP composition), always-recoverable.** Pure steps stay `Either`; only the S3 write is an
  `Effect`, and its typed failure is caught into a `RunResult` so `E` is `never`:
  ```ts
  export const run = (args: RunArgs): Effect.Effect<RunResult, never, S3EventRepository> =>
    Effect.gen(function* () {
      const decoded = decodeHookEvent(args.raw)              // Either — pure
      if (Either.isLeft(decoded)) return { _tag: "ValidationFailed", detail: decoded.left } as const
      const normalized = normalize(decoded.right)            // Option — pure
      if (Option.isNone(normalized)) return { _tag: "Skipped", reason: "non-consumed-event" } as const
      const event = transform(claudeCodeConfig, normalized.value)   // Either — integration-core
      if (Either.isLeft(event)) return { _tag: "ValidationFailed", detail: event.left } as const
      if (args.dryRun) return { _tag: "DryRun", event: event.right, key: buildKey(event.right) } as const
      if (Option.isNone(args.bucket)) {
        return { _tag: "Misconfigured", detail: "no bucket (AWE_EVENT_BUCKET/--bucket)" } as const
      }
      const repo = yield* S3EventRepository
      return yield* repo.putEvent(args.bucket.value, event.right).pipe(
        Effect.map(push => ({ _tag: "Ingested", push }) as const),
        Effect.catchAll(cause => Effect.succeed({ _tag: "WriteFailed", cause } as const))
      )
    })
  ```
- **`cli.ts` never throws:** run the effect with `Effect.runPromiseExit`, then map the result — a
  `Success` carries a `RunResult` whose `_tag` selects a log call via a `Record`; a `Failure` carries
  a `Cause` (only reachable from a genuine defect, since `E` is `never`) which is logged via
  `Cause.pretty`. `process.exit(0)` in a `finally` either way. **`runPromiseExit`, not
  `runPromise`** — the latter rejects on defects, which would reintroduce the throw this contract
  exists to prevent.
- **`settings.json` recipe (README):**
  ```json
  {
    "hooks": {
      "Stop": [{ "type": "command", "command": "claude-events", "async": true, "timeout": 30 }],
      "Notification": [{ "matcher": "permission_prompt|idle_prompt",
        "hooks": [{ "type": "command", "command": "claude-events", "async": true }] }]
    }
  }
  ```
  (Note the nested `hooks` array is required when a `matcher` is present; `Stop` has no matcher.)
- **Logger:** mirror `code-examples/typescript/src/util/logger.ts`; for a CLI, JSON line to stderr is
  the machine record. Error lines include the bad value (truncated) + expectation per `logging.md`.

### Codebase irregularities to ignore
- **Bundler:** use **tsdown** (per the feature decision), not tsup — despite AWE-149's note. The
  shebang comes from `outputOptions.banner` (tsdown does not auto-preserve a source shebang nor
  `chmod +x`; the `postbuild` chmod handles local runs, npm sets the bit from `bin` on install).
- Do **not** add a `spawn`/`detached`/`unref` background-worker — `"async": true` in the hook config
  is the purpose-built mechanism; a detached child is fragile (can be reaped on process-group exit)
  and loses the error log.
- `@personal-events/*` go in **`devDependencies`** (bundled, not runtime deps of the published
  package); `@aws-sdk/client-s3` + `effect` go in **`dependencies`** (external/installed).
- Effect Schema/`Either` come from `effect`; `Either.isLeft`/`isRight` for branching.

### Step-by-step tasks
Execute in order.

#### CREATE apps/claude-events scaffold + tsdown bundle config
- **IMPLEMENT**: `package.json` (bin/files/exports/engines/publishConfig + deps split above),
  `tsconfig.json`, `tsdown.config.ts` (shebang banner, `fixedExtension`, `deps.alwaysBundle`),
  `vitest.config.ts`.
- **PATTERN**: tsdown CLI snippet; AWS SDK external, workspace deps bundled.
- **GOTCHA**: `bin` points at `./dist/cli.mjs` (note `.mjs` from `fixedExtension`); add the
  `postbuild` chmod.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events build` then
  `head -1 dist/cli.mjs` shows the shebang and `node dist/cli.mjs --help`/`--dry-run` runs.

#### CREATE read-payload.ts + config.ts + logger.ts
- **IMPLEMENT**: stdin/file payload reader with TTY guard; bucket/region resolution; winston logger.
- **PATTERN**: `for await` stdin slurp; `code-examples/.../logger.ts`.
- **GOTCHA**: `process.stdin.isTTY` is `undefined` (not `false`) when piped — test
  `if (process.stdin.isTTY)` for the interactive case.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events typecheck`.

#### CREATE run.ts + result.ts (the GCP composition)
- **IMPLEMENT**: `run` per the snippet (decode → normalize → transform → pushEvent, with dry-run and
  misconfig branches), and the `RunResult` union + `_tag`→log `Record`.
- **PATTERN**: AWE-160 `pushEvent`, AWE-161 `decodeHookEvent`/`normalize`/`claudeCodeConfig`,
  integration-core `transform`.
- **GOTCHA**: `normalize` returns "drop" for non-consumed events → `Skipped` (success, exit 0), not
  an error.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events typecheck`.

#### CREATE cli.ts (the always-exit-0 process shell)
- **IMPLEMENT**: argv parse (`--file`/`--dry-run`/`--bucket`/`--region`), construct the `S3Client`
  via `createEventS3Client`, call `run`, map result → stderr log, `process.exit(0)` in `finally`.
- **GOTCHA**: never `throw` out of the bin; a top-level catch logs and still exits 0. Exit 2 would
  block/alter the Claude turn — forbidden here.
- **VALIDATE**: pipe an exemplar into the built bin and confirm exit 0 + a JSON log line on stderr:
  `cat ../../packages/claude-code/exemplars/valid-notification-permission.json | node dist/cli.mjs --dry-run`.

#### WRITE README (settings.json recipe + creds) and ADR
- **IMPLEMENT**: README per the files list (global install, `async:true` recipe, IAM least-priv
  `s3:PutObject`, env vars, classification table); ADR `0001` per `.agents/guidance/adr.md` covering
  direct-CLI vs webhook vs daemon and the `s3-push` extraction.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events exec biome check .` (md ignored) and a
  manual read-through; copy the recipe into a scratch `settings.json` and confirm Claude Code
  accepts it (`/hooks` or a real `Stop`/`Notification` fires the bin and an object lands in S3).

#### CREATE specs + optional integration
- **IMPLEMENT**: `read-payload.spec.ts` (file path; piped stdin via a `Readable`; TTY "no input");
  `run.spec.ts` (each `RunResult` branch — Ingested/Skipped/ValidationFailed/WriteFailed/
  Misconfigured/DryRun — with `pushEvent`'s S3 mocked via `aws-sdk-client-mock` and real exemplars
  from AWE-161); optional `cli.integration.spec.ts` gated on `AWE_TEST_BUCKET` that runs the built
  bin end-to-end against a real bucket.
- **PATTERN**: reuse AWE-161 exemplars; assert exit-0 behavior by testing `run` (pure-ish) directly
  and asserting `cli` maps each tag to the right log without throwing.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events test`.

#### REFACTOR — guidance conformance pass
- **IMPLEMENT**: pass against `general.md` + `typescript.md` + `logging.md`: GCP module split; thin
  composition (no classification/key logic here); `Record` for result→log; winston JSON logs with
  required keys + offending values; no enums; explicit return types; arrow functions; always exit 0.
- **VALIDATE**: `pnpm --filter @alexrmturner/claude-events exec biome check src` + `typecheck` clean;
  optionally `/simplify`.

### Testing strategy
- **Unit**: `readPayload` (file, stdin, TTY-no-input); `run` over every `RunResult` branch using
  real AWE-161 exemplars with S3 mocked (`aws-sdk-client-mock`); `cli` result→log mapping never
  throws and always exits 0 (including on an injected unexpected throw). Mocking S3 is justified per
  `.agents/tests.md` (sad paths + no local S3).
- **Integration**: optional env-gated end-to-end — pipe a real exemplar into the built bin with
  `AWE_EVENT_BUCKET`/creds set and assert the object appears in S3 with the expected key; re-run to
  confirm `AlreadyExists` idempotency; and a **manual** Claude Code wiring test (real `Stop`/
  `Notification` hook fires the installed bin).
- **Edge cases**: malformed payload → `ValidationFailed` + exit 0; non-consumed event → `Skipped`;
  missing bucket → `Misconfigured` + exit 0; missing AWS creds → `WriteFailed(credentials)` + exit 0;
  `--dry-run` prints event + key and writes nothing.

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @alexrmturner/claude-events exec biome check src`
- Level 2 — Types: `pnpm --filter @alexrmturner/claude-events typecheck`
- Level 3 — Unit: `pnpm --filter @alexrmturner/claude-events test`
- Level 4 — Manual/build: `pnpm --filter @alexrmturner/claude-events build`; `head -1 dist/cli.mjs`
  shows the shebang; `cat <exemplar> | node dist/cli.mjs --dry-run` prints the event + key and exits
  0; `npm pack --dry-run` shows only `dist/**` shipping; (optional) wire the `async:true` recipe into
  a scratch `settings.json` and confirm a real hook produces an S3 object.
