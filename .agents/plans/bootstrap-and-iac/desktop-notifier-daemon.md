---
id: AWE-152
title: Desktop notifier daemon (end-to-end S3 → notification)
type: story
status: Implementation Adjustment
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Story: Desktop notifier daemon (end-to-end S3 → notification)

## Definition

### User story
As a user of the personal-events system
I want a lightweight background process that watches the event bucket and pops a native
desktop notification for each new event
So that I am alerted to events on my desktop, proving the whole pipeline works end-to-end
before any webhook ingest exists.

### Acceptance criteria
- A long-running Node app (`apps/desktop-notifier`) polls the S3 event bucket on an interval,
  listing objects and detecting **new** ones since the last seen key (keys sort by ISO
  timestamp, so a high-water-mark key is sufficient).
- Each new object is fetched and parsed via `@personal-events/event-model`; a valid event
  raises a native desktop notification (title/body derived from `eventType`, `priority`,
  `source`, `name`), and the high-water mark advances.
- Notifications are raised via **`toasted-notifier`** behind a **thin typed adapter module**
  so the dependency is isolated (and swappable for a dependency-free
  `osascript`/`notify-send`/`SnoreToast` shell-out later).
- Config (bucket name, region, poll interval, AWS profile/creds) comes from environment /
  config, not hardcoded; logging uses winston per the guidance.
- **End-to-end proof:** with the daemon running against the provisioned bucket, manually
  putting a valid event object into the bucket produces a desktop notification on macOS within
  one poll interval.
- **Failure modes:** a malformed/unparseable object is logged and skipped without crashing or
  blocking later events; missing AWS credentials and an unreachable/empty bucket are handled
  with clear logs and graceful retry rather than an unhandled crash; the daemon does not
  re-notify for already-seen events across a restart (persist the high-water mark).

### Notes / Open questions
- `toasted-notifier` is CJS and single-maintainer; the adapter contains the interop + types so
  a future swap is a one-file change (see feature risks). Confirm the adapter contract in
  `/plan-story`.
- Open: how/where to persist the high-water mark across restarts (local state file vs a marker
  object) and whether to backfill or skip events that predate first run.
- Open: poll interval default and whether to dedupe by full key vs timestamp only.
- Cross-platform notification support (Windows/Linux) is desirable but macOS is the primary
  target for the proof; broader coverage can be validated later.
- Depends on **event-model-package** (AWE-150) for parsing and **infra-s3-and-dns** (AWE-151)
  for the bucket to read from.

## Plan

> Validate library versions and the poll/state design before coding. This app is the
> end-to-end proof — keep it a clean Gather → Compute → Persist pipeline so the notification
> content is a pure, testable function and all I/O sits at the edges.

### Decisions resolved during planning (open questions answered)
- **High-water mark persistence: an atomic local JSON state file** under
  `${XDG_STATE_HOME:-~/.local/state}/personal-events/state.json`, written via write-tmp +
  `rename` (atomic on POSIX). The mark is the **last processed object key** (lexicographic).
- **First-run behavior: skip history, start from "now".** On first run with no state, seed the
  mark to the current ISO timestamp prefix so the daemon does **not** replay the entire bucket
  history as notifications. (Document this; a `--backfill` flag can be a later enhancement.)
- **Dedupe by full key** (not timestamp) — `StartAfter = mark` returns keys strictly greater,
  so the last-seen key is never re-fetched; full-key granularity avoids dropping two events
  that share a millisecond.
- **Poll model: a self-scheduling async tick** (recursive `setTimeout`, NOT `setInterval`) so
  ticks never overlap; exponential backoff with jitter on error, reset on success; clean
  shutdown via `AbortController` on SIGINT/SIGTERM. Default interval 30s (configurable).
- **Notifier adapter: `toasted-notifier` primary, shell-out fallback** behind one
  `NotifierAdapter` interface; a hand-written `.d.ts` shim provides types for the CJS package.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md and .agents/languages/typescript/typescript.md. -->
- **Gather / Compute / Persist** (`general.md`): **Gather** = S3 list (after mark) + get object
  bodies; **Compute** = parse via event-model + a *pure* `toNotification(event)` formatter;
  **Persist** = raise the OS notification + advance/save the high-water mark. Keep the three
  phases in separate functions/modules.
- **Pure, testable formatter** (`general.md`): the notification title/body derivation is a pure
  function of an `Event` — extract it (`notification-content.ts`) so it is unit-testable
  without S3 or the OS.
- **No accumulator loops** (`typescript.md` Looping): list pages via
  `paginateListObjectsV2` collected with `Array.fromAsync`/`flat`; fetch bodies via
  `Promise.all(map(...))`; advance the mark via `reduce`. **No bare `for` writing an accumulator.**
- **Return Values / Objects** (`typescript.md`): parse returns `Either`; functions that can
  fail return typed result/`Either`, never bare `null`/`undefined`.
- **Async** (`typescript.md`): every promise-returning function uses `async`; sequential async
  (if any) threads through `reduce`, never `forEach(async …)`.
- **Logging** (`.agents/guidance/logging.md`, `node/preferences.md`): a default **winston**
  logger; structured logs; every skipped/failed object logs key + reason.
- **Separation at module level** (`general.md`): split `s3-client.ts`, `poller.ts`,
  `state.ts`, `notify.ts` (adapter), `notification-content.ts` (pure), `daemon.ts` (loop),
  `config.ts`, `logger.ts`.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/bootstrap-and-iac/event-model-package.md` — Why: the `parseEvent`/`parseKey`
  API and `Event` type this app consumes.
- `.agents/guidance/logging.md` and `.agents/frameworks/node/preferences.md` — Why: winston
  default-logger conventions.
- `.agents/languages/typescript/typescript.md` (Looping, Async, Return Values) — Why: the
  no-loop / result-type / async rules the poll loop must obey.
- `.agents/tests.md` + `.agents/languages/typescript/typescript-testing.md` — Why: integration
  against a real test bucket, exemplars, fixtures-over-mocks, co-located `.spec.ts`.
- `.agents/plans/bootstrap-and-iac/infra-s3-and-dns.md` — Why: the bucket name/region outputs
  this daemon reads.

### Files to create / change
- `apps/desktop-notifier/package.json` — `@personal-events/desktop-notifier`, `type: module`,
  deps: `@aws-sdk/client-s3`, `@aws-sdk/credential-providers`, `toasted-notifier`, `winston`,
  `@personal-events/event-model` (workspace:*), `effect`; bin entry for the daemon.
- `apps/desktop-notifier/tsconfig.json` / `tsup.config.ts` — extend base; build the daemon.
- `apps/desktop-notifier/types/toasted-notifier.d.ts` — hand-written module shim (notify
  options + callback + default export) so the CJS package types under `esModuleInterop`.
- `apps/desktop-notifier/src/config.ts` — env-driven config (bucket, region, interval, log
  level) validated with effect Schema.
- `apps/desktop-notifier/src/logger.ts` — default winston logger (console + optional file).
- `apps/desktop-notifier/src/s3-client.ts` — `createS3Client()` using `fromNodeProviderChain`,
  eager credential probe (fail fast with a clear message).
- `apps/desktop-notifier/src/poller.ts` — `pollOnce(s3, bucket, mark) → { events, newMark }`
  via `paginateListObjectsV2` (`StartAfter`) + `GetObjectCommand` `transformToString`.
- `apps/desktop-notifier/src/state.ts` — `loadState()`/`saveState()` atomic file in XDG state.
- `apps/desktop-notifier/src/notification-content.ts` — **pure** `toNotification(event)`.
- `apps/desktop-notifier/src/notify.ts` — `NotifierAdapter` interface + `ToastedNotifierAdapter`
  + `ShellNotifierAdapter` (osascript/notify-send/SnoreToast) + `createNotifier()` factory.
- `apps/desktop-notifier/src/daemon.ts` + `src/index.ts` — the self-scheduling loop + entry.
- Spec files co-located (`*.spec.ts`) + `exemplars/` event JSON.

### Relevant documentation
- [`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3) and
  [`paginateListObjectsV2`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/)
  — Why: list-after-mark + pagination; `GetObjectCommand` body `transformToString`.
- [`@aws-sdk/credential-providers` `fromNodeProviderChain`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-credential-providers/)
  — Why: default credential chain + region resolution; graceful missing-cred handling.
- [toasted-notifier (GitHub)](https://github.com/Aetherinox/node-toasted-notifier) — Why: notify
  options, CJS/ESM interop, bundled platform helpers.
- [winston](https://github.com/winstonjs/winston) — Why: default logger; `import winston from "winston"`
  (default import) to avoid the `winston.default.format` ESM trap.

### Patterns to follow
- **Versions:** `@aws-sdk/client-s3` ^3.10xx, `@aws-sdk/credential-providers` ^3.10xx,
  `toasted-notifier` ^10.1, `winston` ^3.19 (pin at install).
- **High-water mark** = last key; `ListObjectsV2` `StartAfter` is **exclusive** (never
  re-returns the mark). Order by **key string**, never `LastModified` (clock skew).
- **Stream:** call `Body.transformToString("utf-8")` exactly once (single-consume).
- **Credentials import gotcha:** `CredentialsProviderError` is in `@smithy/property-provider`
  (not `@aws-sdk/property-provider`).
- **Poll loop:** self-scheduling `setTimeout` tick guarded by `AbortSignal`; backoff
  `min(interval * 2**errCount, maxBackoff)` with ±25% jitter; reset on success.
- **Atomic state write:** temp file in the **same dir** as target, then `rename` (cross-device
  rename is not atomic).
- **toasted-notifier** consumed as `import notifier from "toasted-notifier"` (esModuleInterop)
  with the `.d.ts` shim; wrap `notify(opts, cb)` in a Promise inside the adapter.

### Codebase irregularities to ignore
- `node-notifier` (the upstream of toasted-notifier) is widely referenced online but is
  abandoned and broken on Apple Silicon — **use `toasted-notifier`**, not `node-notifier`.
- Many S3-poll examples use `setInterval` and `LastModified` ordering — both are wrong here
  (overlapping ticks; clock-vs-key). Use the self-scheduling tick + key ordering above.

### Step-by-step tasks
Execute in order.

#### CREATE app scaffold + toasted-notifier type shim
- **IMPLEMENT**: package.json/tsconfig/tsup.config; `types/toasted-notifier.d.ts`; wire
  `typeRoots`/`types` so the shim resolves.
- **VALIDATE**: `pnpm --filter @personal-events/desktop-notifier typecheck`.

#### CREATE config.ts + logger.ts
- **IMPLEMENT**: effect-Schema-validated env config; default winston logger.
- **GOTCHA**: missing `AWS_REGION` warns + defaults; `import winston from "winston"`.
- **VALIDATE**: `pnpm --filter @personal-events/desktop-notifier typecheck`.

#### CREATE s3-client.ts + poller.ts (Gather)
- **IMPLEMENT**: client with eager cred probe; `pollOnce` listing after mark, fetching bodies
  with `Promise.all(map(...))`, advancing mark via `reduce`.
- **PATTERN**: research §1 `pollOnce`/`listNewKeys`/`fetchObjectBody`.
- **VALIDATE**: unit test `pollOnce` against a mocked-only-where-necessary client OR a real
  test bucket (preferred); typecheck.

#### CREATE notification-content.ts (Compute, pure) + notify.ts (Persist adapter)
- **IMPLEMENT**: pure `toNotification(event)`; `NotifierAdapter` with toasted + shell impls +
  factory.
- **PATTERN**: research §5 adapter; osascript args via `JSON.stringify` quoting.
- **VALIDATE**: unit-test `toNotification` (pure); typecheck.

#### CREATE state.ts (Persist) + daemon.ts + index.ts (loop)
- **IMPLEMENT**: atomic load/save; self-scheduling tick wiring Gather→Compute→Persist;
  SIGINT/SIGTERM abort; first-run seed-to-now.
- **VALIDATE**: unit-test state round-trip + atomicity; `pnpm --filter @personal-events/desktop-notifier build`.

#### VERIFY end-to-end
- **IMPLEMENT**: run daemon against the AWE-151 bucket; `aws s3 cp` a valid event object;
  observe a macOS notification within one interval; confirm a malformed object is logged+skipped.
- **VALIDATE**: manual E2E (see Level 4).

#### REFACTOR — guidance conformance pass (general.md + TS guidance)
- **IMPLEMENT**: After the daemon works end-to-end, do a dedicated conformance pass against
  `.agents/general.md` and the TS guidance: (1) the Gather (`s3-client`/`poller`), Compute
  (`notification-content` pure formatter + `parseEvent`), and Persist (`notify`/`state`) phases
  stay in separate modules, one axis of change each; (2) pure `toNotification` receives a sliced
  `Event`, not ambient state (slice-don't-dump); (3) **no accumulator loops** — the poll path
  uses `paginateListObjectsV2` + `Array.fromAsync`/`flat`, `Promise.all(map(...))`, and `reduce`
  for the mark; (4) `Either`/object result types, explicit return types, `async` on
  promise-returning fns, never `forEach(async …)`; (5) no enums, `Record` lookups over if/else
  chains; (6) arrow functions by default; structured winston logs on every skip/failure. Fix
  anything that drifted — it is easy to fall back into a bare loop while wiring I/O.
- **VALIDATE**: `pnpm --filter @personal-events/desktop-notifier exec biome check src` and
  `pnpm --filter @personal-events/desktop-notifier typecheck` clean; optionally run `/simplify` on the diff.

### Testing strategy
- **Unit**: `toNotification` (pure, table-driven over exemplar events); `state.ts`
  load/save/atomicity and ENOENT-first-run; `poller.ts` mark-advance logic.
- **Integration** (per `.agents/tests.md`, real APIs first): run `pollOnce` against a **real
  test S3 bucket** — `PutObject` known event objects via a fixture (tracked by key, torn down
  by key, never bucket-wipe), assert the returned events + advanced mark, and assert winston
  logged successful processing. Use exemplars for both happy and malformed objects; assert the
  malformed one is logged with key+reason and skipped. Mocks only for the genuinely
  hard-to-trigger creds-missing/network-error sad paths.
- **Edge cases / failure modes**: empty bucket; object that fails `parseEvent`; missing creds
  (fail fast, clear log); restart does not re-notify (mark persisted); two events in the same
  millisecond both delivered.

### Validation commands
- Level 1 — Syntax & style: `pnpm --filter @personal-events/desktop-notifier exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/desktop-notifier typecheck`
- Level 3 — Unit + integration: `pnpm --filter @personal-events/desktop-notifier test`
  (integration requires `AWS_REGION` + creds + a `TEST_EVENT_BUCKET`)
- Level 4 — Manual E2E: start the daemon (`node apps/desktop-notifier/dist/index.js`), then
  `aws s3 cp exemplars/valid-github.json s3://<bucket>/<built-key>` and confirm a desktop
  notification appears within the poll interval; kill + restart and confirm no re-notify.

## Execution notes (2026-07-19)

Deltas from the plan as written, and why:

- **`classify.ts` added** between the poller and the notifier: the plan put parsing in the daemon
  loop, but "sort polled bodies into events and rejects" is a pure, total function with its own axis
  of change and its own failure semantics. Keeping it out of `daemon.ts` is what makes "a malformed
  object is logged and skipped" a unit test rather than an integration test.
- **`toNotification` takes only the `Event`** and `daemon.ts` receives a sliced `DaemonSchedule`
  (`pollIntervalMs`, `maxBackoffMs`) rather than the whole `DaemonConfig` — slice-don't-dump.
- **`parseConfig` takes the environment as an argument** instead of reading `process.env`. The whole
  process boundary (env, signals, exit code) is confined to `index.ts`; every module beneath it is
  argument-driven and therefore testable.
- **Backoff jitter takes an injectable `random`**, so `nextDelayMs` is deterministic under test.
- **`fallbackNotifier` latches.** Discovered while running the E2E: under pnpm on macOS,
  `toasted-notifier`'s bundled `terminal-notifier` helper is installed **without its executable
  bit** (the package ships no postinstall to chmod it), so every call fails `EACCES`. Adding it to
  `onlyBuiltDependencies` does not help — there is no install script to run. The `auto` notifier
  already fell through to the shell adapter; it now remembers the failure, so the dead helper costs
  one failed spawn per **process** instead of one per **event**. **This is the feature's flagged
  `toasted-notifier` risk actually materializing, and the adapter design absorbed it** — the fix was
  confined to `notify.ts`.
- **Mocks:** `.agents/tests.md` prefers a real bucket with fixtures. The unit suite uses
  `testing/fake-s3.ts` — a **real** `S3Client` instance with only `send` replaced (the paginator
  rejects anything that is not a real instance), so the production
  `paginateListObjectsV2`/`GetObjectCommand` path is genuinely under test. The real-bucket suite
  exists as `poller.integration.spec.ts` and is opt-in via `TEST_EVENT_BUCKET`; it could not run
  here because the bucket does not exist yet and writing to a real bucket is outside the
  side-effect fence.
- **`daemon.e2e.spec.ts` added** (opt-in via `DESKTOP_NOTIFIER_E2E=1`): drives the real notifier
  from real exemplar object bodies, so the object body → `parseEvent` → `toNotification` → OS chain
  is provable on a machine with no bucket provisioned.

Result: 61 specs green across config, classify, notification-content, notify, poller, state and
daemon; `biome check` and `tsc --noEmit` clean; `tsup` produces a runnable `dist/index.js`.

## Deferred verification — NOT met under the code-and-dry-run fence

AWE-152's end-to-end criterion depends on the AWE-151 bucket, which was not applied (see that
story's deferred section). The following are **unverified**:

| Acceptance criterion | Status | Command the user must run to close it |
| :--- | :--- | :--- |
| Putting a valid event object into the **provisioned** bucket produces a desktop notification within one poll interval | **Unverified** | apply AWE-151, then `EVENT_BUCKET=… node apps/desktop-notifier/dist/index.js` and `aws s3 cp` an exemplar to the built key |
| `pollOnce` against a real bucket returns only objects after the mark | **Unverified** | `TEST_EVENT_BUCKET=<disposable bucket> AWS_REGION=… pnpm --filter @personal-events/desktop-notifier test` |
| A restart against a real bucket does not re-notify | **Unverified** | run the daemon, `aws s3 cp` an event, kill and restart, confirm silence |

### What WAS verified locally

- **Real desktop notifications were raised on this macOS machine** by
  `DESKTOP_NOTIFIER_E2E=1 pnpm --filter @personal-events/desktop-notifier test` and by the
  `shellNotifierAdapter` spec — the notification path itself is proven end to end, including
  AppleScript quoting of a title containing `"` and a message containing a newline.
- **Missing credentials:** running with an empty credential environment logs
  `No usable AWS credentials; the daemon cannot poll the event bucket … "Could not load credentials
  from any providers"` and exits 1. No crash.
- **Unreachable bucket:** running against a non-existent bucket logs
  `Poll failed; backing off before the next attempt … "The specified bucket does not exist"` on each
  tick, backs off to the configured ceiling, keeps the mark, and shuts down cleanly on `SIGTERM`
  (`Shutdown signal received; finishing the current tick` → `Stopped`). No crash, no state written.
- **Missing configuration:** starting with no `EVENT_BUCKET` prints
  `Invalid daemon configuration: DaemonConfig └─ ["bucket"] └─ is missing` and exits 1.
- **Malformed object handling, mark advance, pagination, restart-without-re-notify, and same-
  millisecond events** are all covered by the unit suite against the fake S3 transport — *not*
  against the built daemon binary.

## R1 review fixes (2026-07-19)

Applied after the independent R1 pass (`claude-automated-code-review.md` → `## R1 — 2026-07-19`).
Spec count rose 60 → 86 passing (91 including the five opt-in specs). *(Superseded by the R2 round,
which took this app to **95 passing / 100 including the opt-in specs** — see § R2 review fixes.)*

- **#2 MAJOR — `runDaemon` retained one promise and one async frame per tick, forever.** Returning
  the recursive call from an `async` function chains every tick's promise to the next, so the first
  never settles until the last does — ~2,880 retained frames/day at the default interval, in a
  process meant to run for weeks. It was also an unrecorded deviation from the plan's resolved
  decision ("a self-scheduling async tick (recursive `setTimeout`)"). Rewritten to schedule each tick
  from inside the previous tick's timer callback and discard its promise, so frames unwind; the loop
  now holds only `state` and a timer handle, which **is** the shape the plan specified.
  - Care was needed to preserve shutdown semantics: abort **between** ticks stops immediately, abort
    **during** a tick lets that tick finish raising notifications and persisting its mark (the log
    line says "finishing the current tick"). A first attempt resolved on the abort event
    unconditionally and cut the in-flight tick short — caught by the existing spec, and now guarded
    by a `ticking` flag. *(Superseded by R2-4: the spec added here did **not** discriminate the
    chained shape and was renamed to what it actually tests — "keeps polling on the configured
    interval until it is aborted". The non-chaining shape is a documented review responsibility in
    `CLAUDE.md`, not a guarded one. The `ticking` flag and the shutdown semantics above are unchanged
    and are still spec-covered.)*
- **#4 MAJOR — no bucket pre-flight**, which `.agents/guidance/aws.md` § S3 § Usage in Code
  explicitly mandates. A typo'd `EVENT_BUCKET` produced a process that looked healthy: it started,
  backed off to the 5-minute ceiling, and notified nobody forever. `probeBucket` (`HeadBucketCommand`,
  same tagged-union shape as `probeCredentials`) now gates `start()`. `HeadBucket` answers with a
  bodyless 404/403 whose SDK rendering is a bare `UnknownError`, so `describeBucketFailure` maps the
  status onto what to actually fix. **Verified against the built daemon:** a non-existent bucket now
  exits 1 with *"no such bucket in this region — check EVENT_BUCKET and AWS_REGION"*.
- **#6 MAJOR — no spec asserted any log line**, while `feature.md` marked "a malformed object is
  logged and skipped" as **Met**. `.agents/tests.md` requires logging itself to be validated, and for
  this daemon the log line *is* the entire user-visible signal for anything not turned into a
  notification. Added `testing/capture-logger.ts` — a real winston logger with a `Stream` transport
  and `format.json()`, so assertions run against the same serialization the file transport produces,
  `defaultMeta` included. Five new specs assert the skip warning (level, `key`, `reason` naming the
  field), a delivery info line per event with its triage fields, `service`/`env` on every record, the
  error line for an undelivered notification, and that an idle tick is silent.
- **#13 MINOR — `logLevel` and `env` were bare non-empty strings.** `ENV=production` passed and was
  silently coerced to `dev`, mis-stamping every shipped record; `LOG_LEVEL=verbse` passed and left
  the daemon running and emitting nothing. Both are now `Schema.Literal` unions, which also deleted
  `resolveEnv`/`deploymentEnvByName` from `logger.ts`. **Deviation:** the accepted `env` set adds
  `local` to `.agents/guidance/logging.md`'s four — `.agents/guidance/aws.md` lists `local` among
  this project's environments and this is a laptop-resident daemon, so rejecting it would make the
  tool unusable out of the box. It is an explicit fifth value, not a fallback; an unrecognized `ENV`
  still fails startup. Recorded in `CLAUDE.md` § Documented carve-outs. *(Superseded by R2-6: the
  carve-out is now one project-wide vocabulary — `local`, `dev`, `qa`, **`staging`**, `prod` — shared
  verbatim with the Terraform `env` variable, so the third value is no longer spelled `stage` here
  either.)*
- **#14 MINOR — slice-don't-dump.** `deliverAll`/`deliverOne` destructured `{ notifier, logger }` but
  their *parameter type* was still the whole `DaemonDependencies`, so `s3`/`bucket`/`stateFile`
  remained in reach. Introduced `Delivery` and narrowed both.
- **#7 MAJOR (see AWE-150)** — this app's three duplicated exemplars are deleted; it now reads the
  contract's canonical data from `@personal-events/event-model/testing` and keeps only
  `not-json.txt`, which is genuinely its own concern.
- **#9 MINOR** — the four local `describeCause` copies now import the one in the event-model package.

### Re-verified locally after the fixes

- Missing config, mistyped `ENV`, and an unknown `LOG_LEVEL` each exit 1 naming the offending field.
- No credentials → *"Could not load credentials from any providers"*, exit 1.
- Non-existent bucket → the new pre-flight refuses to start, exit 1 (previously: started and backed
  off forever).
- `DESKTOP_NOTIFIER_E2E=1` still raises real macOS notifications from real exemplar bodies.

## R2 review fixes (2026-07-19)

Applied after the independent R2 pass (`claude-automated-code-review.md` → `## R2 — 2026-07-19`).
Spec count rose 86 → **95 passing** (100 including the five opt-in specs).

- **R2-3 — the bucket pre-flight killed the process on evidence that was not about the bucket.**
  `probeBucket` now returns a third outcome, `BucketProbeInconclusive`: only 404/403/301 (statuses
  that genuinely answer *"does this bucket exist here"*) still refuse to start; a transport failure,
  a 5xx, or any other status logs `warn` and starts into the normal back-off loop. Seven specs pin
  the split, and the typo'd-`EVENT_BUCKET` behaviour the R1 #4 fix exists for is preserved.
- **R2-4 — the loop-shape guard spec.** Disputed and upheld; see § R1 #2 above and `feature.md`.
- **R2-6 — one environment vocabulary**, `local`/`dev`/`qa`/`staging`/`prod`, shared verbatim with
  Terraform and stated once in `CLAUDE.md`. `stage` is now rejected; `config.spec.ts` asserts it.
- **R2-7 — `LoadStateFailure` was logged at the same level as a first run.** `stateOutcomeLevels` is
  a total `Record` over `LoadStateResult["_tag"]`, so a new outcome has to choose a level.
- **R2-9 — a fall-through `if`** at `daemon.ts:67` took the two-branch form.

## R3 review fixes (2026-07-19)

Applied after the independent R3 final-gate pass (`claude-automated-code-review.md` → `## R3`).

- **R3-2** — `README.md`'s `ENV` table still offered `stage`, a value the daemon now refuses to start
  on. Corrected to `staging`; this was the last dangling instance in the repo.
- **R3-3** — the loop-shape rationale was measurably wrong in `CLAUDE.md`, `daemon.spec.ts` and
  `feature.md` ("heap retention does not diverge"), and overclaimed in the opposite direction in
  `daemon.ts` ("one async frame per tick"). R3 measured the chained shape: the frames and their
  captures *are* collected (tail position), but the chain of pending promise objects leaks **~97
  bytes/tick, linear and unbounded** — ~280 KB/day at the 30 s default. All four sites now say that.
- **R3-6** — `index.ts:50`'s inconclusive-probe branch was a fall-through `if` the guard-clause
  carve-out does not cover (it logs and continues); it now carries the two-branch form.
