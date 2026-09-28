---
id: AWE-152
title: S3 poll core — prefix window, cursor & restart semantics
type: story
status: todo:backlog
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-08-03
---

# Story: S3 poll core — prefix window, cursor & restart semantics

> **Restructured 2026-08-03.** Re-scoped from *Desktop notifier daemon* and split. This story now owns **only** the read loop — time-prefix-bounded listing, cursor tracking, restart semantics and `Schedule`-driven backoff. Decoding and output moved to AWE-216; everything about desktop notifications moved to the `macos-notifications` feature (AWE-217, AWE-218). **The `## Plan` below still describes the notifier daemon — re-run `/plan-story` before executing.**

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
- `apps/desktop-notifier/src/daemon.ts` + `../../../apps/client` — the self-scheduling loop + entry.
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
