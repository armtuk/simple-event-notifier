---
id: AWE-159
title: Slack Socket Mode client (Railway service → S3)
type: story
status: Abandoned
parent: ./feature.md
branch: feat/slack-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-29
updated: 2026-07-19
---

# Story: Slack Socket Mode client (Railway service → S3)

> **ABANDONED 2026-07-19** along with its parent feature `slack-integration` — shelved for lack
> of Slack app-creation permissions. See `./feature.md` for the rationale.
>
> **Platform note (2026-07-20):** Railway was removed system-wide; the project is now AWS-only. This
> story's persistent Railway container no longer reflects the platform (a revived Slack integration
> would run on AWS Fargate/ECS, since Socket Mode needs a long-lived websocket a Lambda can't hold).
> Left as historical reference only — not rewritten, as the story is abandoned. See `./feature.md`.

## Definition

### User story
As a Slack user on a single workspace
I want a persistent service that connects to Slack over Socket Mode and stores my DMs,
@mentions, and watched-channel messages as canonical events
So that I receive Slack signals on S3 in real time without exposing any public endpoint.

### Acceptance criteria
- A persistent **Railway service** (`apps/slack-client`, containerized) using **`@slack/bolt`**
  in **Socket Mode** (`SocketModeReceiver`) with a **bot token (`xoxb-`)** and an **app-level
  token (`xapp-`, scope `connections:write`)** — no public URL, no signing secret.
- Subscribes to `app_mention`, `message.im`, and `message.channels` (the bot must be invited to
  allowlisted channels); each event is validated + normalized + classified via the AWE-158
  mapping and written to S3 as a canonical event.
- **Dedupe by `event_id`** (persisted) so reconnects/redeliveries never double-write to S3.
- **Auto-reconnect:** relies on the Socket Mode client's reconnection (Node SDK linear backoff);
  a `disconnect`/socket close recovers without manual intervention and is logged.
- **Bot-loop safe:** the app never ingests its own or other bots' messages (per AWE-158 filter).
- Config/secrets (bot token, app-level token, AWS creds + bucket/region, channel allowlist) come
  from **Railway env/secrets**; logging uses winston; a minimal `/health` route (or disabled
  health check) keeps Railway happy without opening a public webhook.
- **Failure modes:** missing/invalid Slack token (clear log, no crash-loop), missing AWS creds
  (clear log), Slack rate-limit/429 on any Web API call (honor `Retry-After`), malformed event
  (logged + skipped), and a connection drop (auto-reconnect, no lost in-flight beyond Socket
  Mode's at-most-once nature — documented).

### Notes / Open questions
- `@slack/bolt` is **CJS-only**; consume via `esModuleInterop` default import in our ESM build —
  confirm it runs clean on Node 24 and document the import pattern.
- Open: where to persist the `event_id` dedupe set on Railway (volume vs a small S3 marker vs an
  in-memory LRU sufficient for the reconnect window) — decide in `/plan-story`.
- Open: containerization approach (Dockerfile vs Nixpacks) and Railway service config; reconcile
  with the desktop-notifier daemon patterns (AWE-152) and the github poller (AWE-157).
- Open: Socket Mode is single-connection / not horizontally scalable — fine for one user; note
  the reported long-uptime delivery-stall risk and add basic liveness monitoring.
- Depends on `slack-event-mapping` (AWE-158) and `event-model`/S3 (`bootstrap-and-iac`).

## Plan

> Validate library versions and the connection/dedup design before coding. Keep this a thin
> Gather → Compute → Persist runtime: the Bolt client gathers events, the AWE-158 normalizer +
> `integration-core.transform` compute the canonical event (pure), and Persist writes to S3 +
> records the dedup key. Mirror the desktop-notifier daemon (AWE-152) and github poller (AWE-157)
> for the daemon/deploy shape.

### Decisions resolved during planning (open questions answered)
- **Dedup state:** an in-memory LRU/Set of recent `event_id`s is sufficient for the
  reconnect/redelivery window (Socket Mode is at-most-once; redeliveries are rare and bounded).
  Persist a small **last-seen marker is not required**; if cross-restart dedup is wanted later,
  add a tiny S3 marker. v1 = in-memory LRU (documented limitation).
- **Containerization:** a `Dockerfile` (matches a Railway always-on service; keep parity with
  AWE-157's approach) building the tsup bundle; a minimal `/health` HTTP route so Railway's
  health check passes **without** exposing a webhook (Socket Mode opens no server by default).
- **Tokens/secrets:** bot token `xoxb-`, app-level token `xapp-` (scope `connections:write`),
  AWS creds + bucket/region, and the channel allowlist — all from **Railway env/secrets**. **No
  signing secret** (that's the HTTP path, not Socket Mode).
- **Bolt usage:** `new App({ token, appToken, socketMode: true })`; subscribe via `app.event(...)`
  handlers for `app_mention` and `message`. Bolt is **CJS** → `import bolt from "@slack/bolt";
  const { App } = bolt` under `esModuleInterop`.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md and .agents/languages/typescript/typescript.md. -->
- **Gather / Compute / Persist** (`general.md`): **Gather** = the Bolt Socket Mode event
  callback; **Compute** = AWE-158 `normalize` + `integration-core.transform` (pure, already
  built); **Persist** = `PutObject` to S3 (event-model key) + record `event_id` in the dedup set.
  Keep these in separate modules.
- **No accumulator loops / result types / async rules** (`typescript.md`): event handling is
  per-event (no batch accumulator); functions return `Either`/object results; `async` on every
  promise-returning fn; no `forEach(async …)`.
- **Logging** (`.agents/guidance/logging.md`, `node/preferences.md`): default **winston** logger;
  structured logs for connect/disconnect/reconnect, each ingested event (key), each drop (reason),
  and each error.
- **Separation at module level**: `config.ts`, `logger.ts`, `s3-writer.ts`, `dedup.ts`,
  `slack-app.ts` (Bolt wiring + handlers), `index.ts` (bootstrap).
- **Reuse**: write-to-S3 should reuse the same event-model key/`PutObject` helper pattern as the
  desktop-notifier (AWE-152) and github paths — extract a shared S3 event-writer if duplication
  appears (DRY rule of three across the consumers).

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/slack-integration/slack-event-mapping.md` (AWE-158) — Why: the `normalize`
  API + slack mapping config this client consumes, and the `event_id`-as-idempotency-key contract.
- `.agents/plans/bootstrap-and-iac/desktop-notifier-daemon.md` (AWE-152) — Why: the daemon shape,
  winston logger, env config, graceful shutdown, and the S3 client/event-model usage to mirror.
- `.agents/plans/github-integration/github-notifications-poller.md` (AWE-157) — Why: the Railway
  persistent-service + Dockerfile + secrets pattern to mirror.
- `.agents/plans/bootstrap-and-iac/event-model-package.md` (AWE-150) — Why: `buildKey` + canonical
  `Event` for the S3 write.
- `.agents/frameworks/node/preferences.md`, `.agents/guidance/logging.md` — Why: winston + node
  server conventions.

### Files to create / change
- `apps/slack-client/package.json` — `@personal-events/slack-client`, `type: module`, deps
  `@slack/bolt`, `@aws-sdk/client-s3`, `@personal-events/slack` + `@personal-events/event-model`
  (workspace:*), `winston`; bin entry.
- `apps/slack-client/tsconfig.json` / `tsup.config.ts` — extend base; build the service.
- `apps/slack-client/src/config.ts` — effect-Schema-validated env (tokens, bucket, region,
  channel allowlist, log level).
- `apps/slack-client/src/logger.ts` — default winston logger.
- `apps/slack-client/src/s3-writer.ts` — `writeEvent(event) → PutObject` using the event-model key.
- `apps/slack-client/src/dedup.ts` — bounded in-memory `event_id` LRU/Set.
- `apps/slack-client/src/slack-app.ts` — Bolt `App` (socketMode), `app.event("app_mention")` +
  `app.event("message")` handlers → `normalize` → write (skip if dedup hit / drop result);
  `/health` custom route.
- `apps/slack-client/src/index.ts` — bootstrap: build config, start app, SIGINT/SIGTERM shutdown.
- `apps/slack-client/Dockerfile` + Railway config — container + deploy.
- Spec files co-located.

### Relevant documentation
- [Bolt-JS Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — Why:
  `socketMode: true`, app-level token, `SocketModeReceiver`.
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) — Why:
  app-level token lifecycle, reconnect/`disconnect` semantics.
- [`@slack/bolt` npm](https://www.npmjs.com/package/@slack/bolt) — Why: pin the version (≈4.7.x),
  confirm Node 24 support; note CJS-only.
- [AWS SDK v3 `@aws-sdk/client-s3` `PutObjectCommand`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-s3/Class/PutObjectCommand/)
  — Why: writing the event object.

### Patterns to follow
- **Versions:** `@slack/bolt` ≈4.7.x (CJS — `import bolt from "@slack/bolt"; const { App } = bolt`),
  `@aws-sdk/client-s3` ^3.x, `winston` ^3.19 (default import).
- **Subscribe** to `app_mention` and `message`; let AWE-158's normalizer do all filtering
  (bot/own/noisy/allowlist) — the handler just forwards the raw envelope and acts on the result.
- **Auto-reconnect** is built into the Socket Mode client (Node SDK **linear** backoff); log
  `disconnect`/reconnect; do not hand-roll reconnection.
- **Dedup** by `event_id` before writing; an already-seen id is a logged no-op.
- **Health route:** add a minimal `customRoute` `/health` (or disable Railway's health check) —
  Socket Mode otherwise opens no port.

### Codebase irregularities to ignore
- `@slack/bolt` is CJS despite our ESM project — the default-import interop is expected; do **not**
  attempt a named ESM import of `App`.
- `@slack/events-api` is **deprecated** — do not use it; Bolt is the supported path.
- Don't key bot detection on `subtype === "bot_message"` (handled in AWE-158, but never
  re-introduce the check here).

### Step-by-step tasks
Execute in order.

#### CREATE apps/slack-client scaffold + config + logger
- **IMPLEMENT**: package.json/tsconfig/tsup; effect-Schema env config; winston logger.
- **GOTCHA**: Bolt CJS default-import; `import winston from "winston"`.
- **VALIDATE**: `pnpm --filter @personal-events/slack-client typecheck`.

#### CREATE s3-writer.ts + dedup.ts (Persist)
- **IMPLEMENT**: `writeEvent` via `PutObjectCommand` + event-model key; bounded `event_id` LRU.
- **VALIDATE**: unit-test the dedup LRU; typecheck. (S3 write integration-tested below.)

#### CREATE slack-app.ts + index.ts (Gather + wiring)
- **IMPLEMENT**: Bolt socketMode App, `app_mention`/`message` handlers → normalize → dedup →
  writeEvent; `/health` route; SIGINT/SIGTERM graceful stop.
- **VALIDATE**: build succeeds; a dry-run with fake tokens fails fast with a clear log.

#### ADD Dockerfile + Railway config; document Slack app setup
- **IMPLEMENT**: container build; Railway env/secrets; a README/ADR for creating the **internal**
  Slack app, scopes (`app_mentions:read`, `im:history`, `channels:history`), the `xapp-` token
  (`connections:write`), and install.
- **VALIDATE**: container builds; documented setup is followable end to end.

#### REFACTOR — guidance conformance pass (general.md + TS guidance)
- **IMPLEMENT**: G-C-P module split intact; pure handoff to AWE-158; no accumulator loops;
  result/`Either` types; structured winston logs on connect/ingest/drop/error; extract a shared
  S3 event-writer if it now duplicates the desktop/github writers.
- **VALIDATE**: `pnpm --filter @personal-events/slack-client exec biome check src` and
  `… typecheck` clean; optionally `/simplify` the diff.

#### VERIFY end-to-end
- **IMPLEMENT**: run the client with a real internal Slack app against the dev bucket; send a DM,
  an @mention, and an allowlisted-channel message; confirm three canonical events on S3; confirm
  a bot/own message and a non-allowlisted channel produce nothing; kill+restart and confirm no
  duplicate writes within the dedup window.
- **VALIDATE**: manual E2E (Level 4).

### Testing strategy
- **Unit**: `dedup` LRU (evicts, dedupes); config validation (missing token → typed fail);
  the handler's decision path over exemplar envelopes (delegates to AWE-158, asserts
  write-vs-skip-vs-drop) using a fake S3 writer.
- **Integration** (per `.agents/tests.md`, real APIs first): write exemplar events to a **real
  test S3 bucket** via the actual `s3-writer` (fixtures tracked + torn down by key, never
  bucket-wipe) and assert the object + key + winston success log; assert a malformed envelope is
  logged + skipped. Live Slack delivery is covered by the manual E2E (a real workspace/socket is
  impractical to automate in CI).
- **Edge cases / failure modes**: missing/invalid Slack token (clear log, no crash-loop), missing
  AWS creds, connection drop → auto-reconnect, duplicate `event_id` within the window (single
  write), a `message` with `bot_id` (no write, no loop).

### Validation commands
- Level 1 — Style: `pnpm --filter @personal-events/slack-client exec biome check src`
- Level 2 — Types: `pnpm --filter @personal-events/slack-client typecheck`
- Level 3 — Unit + integration: `pnpm --filter @personal-events/slack-client test`
  (integration needs `AWS_REGION` + creds + a `TEST_EVENT_BUCKET`)
- Level 4 — Manual E2E: run with a real internal Slack app + `xapp-`/`xoxb-` tokens; send a DM /
  @mention / allowlisted-channel message; confirm canonical events on S3; restart → no dupes.
