---
id: AWE-157
title: GitHub activity poller — Events + Notifications (Railway fallback)
type: story
status: Implementation Adjustment
parent: ./feature.md
branch: github-integration
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-07-19
---

# Story: GitHub activity poller — Events + Notifications (Railway fallback)

## Definition

### User story
As a GitHub user who CANNOT configure webhooks (no admin rights)
I want a background service that polls both my GitHub activity (Events API) and my Notifications
inbox and stores them as canonical events
So that I still receive rich GitHub events on S3 using only personal access tokens.

### Acceptance criteria
- A persistent **Railway service** (`apps/github-poller`, containerized) that **dual-polls** two
  complementary sources on an interval (decided: fold both into this one service):
  - **Notifications API** (`GET /notifications`) using a **classic PAT** with `notifications`
    (or `repo`) scope — reason-coded user signals (review_requested, mention, security_alert).
    **Hard constraint (verified):** this endpoint does **not** support fine-grained PATs or App
    tokens, so it specifically requires a *classic* PAT.
  - **Events API** (`GET /users/{username}/received_events`) using a token (any type, incl. a
    fine-grained PAT) — richer payloads carrying actor + action that the Notifications inbox
    lacks. Note its limits: 30s–6h latency, 30-day / max-300-event retention.
- **Conditional polling for both:** Notifications uses `If-Modified-Since`/`Last-Modified`;
  Events uses `ETag`/`If-None-Match`. Both honor `X-Poll-Interval` (re-read each response) and a
  `304 Not Modified` is a no-op that does **not** count against the rate limit; the
  Notifications poll also uses the `since` cursor.
- Each new item (from either source) is validated (AWE-154 schemas), normalized via the
  source-appropriate path (`notification` reason vs `events_api` eventType trigger), mapped via
  the GitHub config, and written to S3 as a canonical event.
- **Dedupe per source** (Notifications: id + `updated_at`; Events: event `id`), persisted, so no
  duplicate S3 events across polls or restarts — and so the two sources don't double-write the
  same underlying activity where they overlap.
- Secrets/config (the **two** PATs, AWS creds to write S3, bucket/region, per-source poll
  interval) come from Railway env/secrets; logs use winston.
- **Failure modes:** missing/invalid PAT for either source (clear log, no crash-loop; the other
  source keeps working), GitHub `5xx`/`429` rate-limit (back off, honor
  `Retry-After`/`X-Poll-Interval`), malformed item (logged + skipped), and restart (resume from
  each persisted cursor without re-notifying).

### Notes / Open questions
- Notification `reason` values (`review_requested`, `mention`, `assign`, …) differ from webhook
  event names — classification uses the **notification sub-map** of the GitHub mapping config.
- Open: where to persist the cursor/dedupe state on Railway (volume vs a small S3 marker object)
  — decide in `/plan-story`.
- Open: notifications are lower-fidelity than webhook payloads (subject URL, not full body);
  decide whether to fetch the referenced subject for richer payloads or store the notification
  as-is (start as-is).
- **Resolved (user decision):** fold the Events API into this story — the service dual-polls
  Events + Notifications (rather than a separate `github-events-poller` story). Requires two
  credentials (classic PAT for Notifications; any token for Events).
- Open: whether to fetch the referenced subject/commit for even richer payloads, or store the
  raw item — start with the raw payload from each source.
- Open: whether to also auto-mark-read on GitHub after ingest (probably not; keep read-only).
- Depends on `github-event-mapping` (AWE-154) and `event-model` (AWE-150) + the S3 bucket
  (AWE-151).

> **Resolved in planning (2026-06-29):**
> - **State lives in S3, not a Railway volume.** A `PollerStateRepository` persists per-source
>   cursors + bounded dedupe sets to `state/github-poller.json` in the event bucket. Rationale:
>   Railway volumes cause **redeploy downtime** and don't survive a service move; S3 is already
>   the source of record, survives restarts/redeploys, and needs no extra infra. (Confirmed via
>   library check — Railway volume redeploy-downtime caveat.)
> - **Reuses `@personal-events/event-sink`'s `S3EventRepository`** (the shared S3 write path from
>   AWE-155) — identical event keys/writes as the webhook path; no duplicated S3 logic.
> - **Per-source dedupe only (v1).** Notifications key = `${id}:${updated_at}`; Events key =
>   event `id`. Cross-source overlap (the same PR surfacing in *both* inboxes) is **intentionally
>   kept as two distinct canonical events** (different `channel`/fidelity) — v1 does not correlate
>   them. If that double-signal is unwanted, a future cross-source correlation key is the lever.
> - **Per-source isolation.** Each source runs its own self-scheduling loop; a missing/invalid PAT
>   or a persistent error on one source **must not** stop the other or crash the process.
> - **This story finalizes the reserved `events_api` trigger** (AWE-154): it adds
>   `EventsApiItemSchema`, `normalizeEventsApi`, and `events_api` rules to **`packages/github`**
>   (additive to AWE-154's package), so classification stays config-driven and single-homed.
> - **Read-only**: do not mark notifications read on GitHub (keeps the inbox intact; dedupe is ours).

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. Depends on
> AWE-154 (`packages/github` normalizer + mapping), AWE-150 (`event-model`), AWE-151 (the S3
> bucket), and AWE-155's shared `@personal-events/event-sink`. Mirror the long-running-daemon
> shape of `apps/desktop-notifier` (AWE-152): self-scheduling `setTimeout` loop, `AbortController`
> shutdown, backoff+jitter on error.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
From `.agents/general.md`, `.agents/guidance/aws.md`, `.agents/guidance/logging.md`, `.agents/languages/typescript/*`:
- **Gather / Compute / Persist** per cycle: **Gather** = conditional HTTP fetch (per-source
  repository) + load state; **Compute** = validate + normalize + `transform` + compute the fresh
  set vs the dedupe set (all pure); **Persist** = `S3EventRepository.putEvents` + save state.
- **Repository pattern**: each external system behind a repository — `GithubNotificationsRepository`,
  `GithubEventsRepository` (GitHub HTTP), `PollerStateRepository` (S3 state), `S3EventRepository`
  (shared, events). The cycle/loop orchestrators make no raw `fetch`/SDK calls.
- **Module SRP**: loop mechanics, per-source cycle, each repository, config, dedupe, and the
  daemon wiring are separate files.
- **No accumulator loops**: dedupe is `items.filter(i => !seen.has(keyOf(i)))` + a bounded
  `new Set([...fresh.map(keyOf), ...seen].slice(0, N))`; sequential cycles thread state via
  `reduce`/recursion, never a `for` filling a mutable accumulator. Read
  `.agents/code-examples/typescript/src/looping.ts`.
- **No if/else on a discriminator**: HTTP-status handling (200/304/429/5xx) and source selection
  are `Record` lookups; backoff is a pure function of attempt count.
- **Result/error types**: repositories return tagged result unions
  (`NotModified` / `Items` / `RateLimited` / `Failure`); no throws across boundaries.
- **Looping/iteration**: the poll loop is a **self-scheduling recursive `setTimeout`** (not
  `setInterval`), each tick scheduling the next with `max(baseInterval, xPollInterval, backoff)`.
- **Sequential async**: when writing N events per cycle, prefer `Promise.all` (order-independent);
  if any ordering is needed, thread via `reduce` (never a bare `for await`).
- **Logging** (`logging.md`): winston, `import winston from "winston"`; service `github-poller`;
  every line carries `source` (`notifications`|`events`) + rate-limit context; **never** log PATs;
  malformed items log the offending id + reason at `warn` and are skipped.
- **Config validation**: parse env via an effect Schema; required-vs-optional per source (only the
  PAT present enables that source). Fail a *source*, never crash the *process*.
- **No enums**, explicit return types, no trailing semicolons, `.ts` import extensions, Node ≥24 ESM.
- **ADR**: reference the AWE-153 feature ADR (the dual-path's poller limb); add a revision-log
  entry for the S3-state + per-source-isolation decisions.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/plans/bootstrap-and-iac/desktop-notifier-daemon.md` (AWE-152) — Why: the daemon shape
  to mirror (self-scheduling `setTimeout`, `AbortController` on SIGINT/SIGTERM, backoff±25% jitter,
  S3 client construction; `winston` default import; `CredentialsProviderError` in `@smithy/property-provider`).
- `packages/github/src/index.ts` (AWE-154) — Why: `normalizeNotification`, `githubToEvent`,
  `loadGithubConfig`, and the reserved `EventsApiTriggerSchema` this story finalizes.
- `packages/event-sink/src/index.ts` (AWE-155) — Why: the shared `S3EventRepository`.
- `packages/event-model/src/index.ts` — Why: `type Event`, `buildKey`.
- GitHub Notifications + Events API docs (below) — Why: conditional-request headers, the classic-PAT
  constraint, the 30-day/300-event Events cap.
- `.agents/guidance/aws.md`, `.agents/guidance/logging.md` — full read.

### Files to create / change
**Poller app (`apps/github-poller/`):**
- `package.json` — `@personal-events/github-poller`; deps `effect`, `winston`,
  `@aws-sdk/client-s3`, `@personal-events/event-model`, `@personal-events/github`,
  `@personal-events/event-sink` (`workspace:*`); dev `tsup`, `vitest`. (Uses global `fetch` —
  Node ≥24 — no HTTP client dep.)
- `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `Dockerfile` (or rely on Railway
  Railpack auto-detect) + `railway.json` if needed.
- `src/config.ts` — env Schema (`GITHUB_NOTIFICATIONS_PAT?`, `GITHUB_EVENTS_PAT?`,
  `GITHUB_USERNAME`, `EVENT_BUCKET_NAME`, `AWS_REGION`, `STATE_KEY`, `NOTIFICATIONS_INTERVAL_MS`,
  `EVENTS_INTERVAL_MS`, `ENV`); per-source enablement.
- `src/logger.ts` — winston factory.
- `src/github-http.ts` — authenticated conditional-`fetch` helper (base URL, auth header,
  `If-Modified-Since`/`If-None-Match`, parse `Last-Modified`/`ETag`/`X-Poll-Interval`/`Retry-After`).
- `src/notifications-repository.ts` — `GithubNotificationsRepository.poll(cursor): Promise<PollResult>`.
- `src/events-repository.ts` — `GithubEventsRepository.poll(cursor): Promise<PollResult>`.
- `src/poller-state-repository.ts` — `PollerStateRepository.load()/save(state)` (S3 JSON object).
- `src/dedupe.ts` — pure `partitionFresh(items, seen, keyOf): { fresh, nextSeen }` (bounded).
- `src/backoff.ts` — pure `nextDelayMs(attempt, base, xPollInterval, retryAfter)`.
- `src/source-poller.ts` — generic self-scheduling loop `runSourcePoller(opts)` (mechanics only).
- `src/notifications-cycle.ts` / `src/events-cycle.ts` — one cycle: fetch→normalize→transform→dedupe→persist→save.
- `src/daemon.ts` — wire config → repos → start enabled sources → signal handling.
- `src/index.ts` — entrypoint (`daemon.start()`).
- Co-located specs for `dedupe`, `backoff`, `config`, each repository, each cycle, `source-poller`.

**Shared package extension (`packages/github/`):**
- `src/events-api.ts` — `EventsApiItemSchema` (`id`, `type`, `actor`, `repo`, `payload.action?`, `created_at`).
- finalize `EventsApiTriggerSchema` (`{ channel: "events_api", type, action? }`) in `src/github-trigger.ts`.
- `normalizeEventsApi` added to `src/normalizer.ts`.
- add `events_api` rules to `src/github-mapping.json` (e.g. `PullRequestEvent`+`review_requested`,
  `PushEvent`, `ReleaseEvent`); plus exemplars `events-api-*.json`.

**Terraform (`infra/personal-events/`):**
- `github-poller-iam.tf` — `aws_iam_user "github_poller"` + least-priv policy: `s3:PutObject` on
  the event prefix, `s3:GetObject`/`s3:PutObject` on `${bucket}/state/github-poller.json`.
  (Generate access keys **out-of-band** for Railway secrets — avoid keys in TF state; or
  `aws_iam_access_key` with a sensitive output if acceptable for this personal project.)

### Relevant documentation
- [REST: Notifications (classic-PAT only, conditional requests)](https://docs.github.com/en/rest/activity/notifications) — Why: `If-Modified-Since`/`Last-Modified`, `X-Poll-Interval`, `since`, 304-not-billed, classic-PAT constraint.
- [REST: Events (`received_events`, ETag, 30d/300 cap)](https://docs.github.com/en/rest/activity/events) — Why: `If-None-Match`/`ETag`, latency + retention limits, fine-grained-PAT compatibility.
- [Endpoints available for fine-grained PATs](https://docs.github.com/en/rest/authentication/endpoints-available-for-fine-grained-personal-access-tokens) — Why: confirms Events ✓ / Notifications ✗ for fine-grained.
- [Railway: Node service, variables, volumes](https://docs.railway.com/guides/deploy-node-express-api-with-auto-scaling-secrets-and-zero-downtime) — Why: deploy pattern, env/secrets, the volume-redeploy-downtime caveat behind the S3-state decision.

### Patterns to follow
- **Self-scheduling source loop** (mechanics; no business logic):
  ```ts
  export const runSourcePoller = (opts: {
    name: string; intervalMs: number; signal: AbortSignal; log: Logger
    runCycle: () => Promise<{ pollIntervalMs?: number }>
  }): void => {
    let attempt = 0
    const tick = async (): Promise<void> => {
      if (opts.signal.aborted) return
      const { pollIntervalMs } = await opts.runCycle().then(r => (attempt = 0, r))
        .catch(error => (attempt += 1, opts.log.error("cycle failed", { source: opts.name, error }), { pollIntervalMs: undefined }))
      if (opts.signal.aborted) return
      const delay = nextDelayMs(attempt, opts.intervalMs, pollIntervalMs, undefined)
      setTimeout(() => void tick(), delay)
    }
    void tick()
  }
  ```
- **Conditional fetch result** (tagged union, Record-dispatched):
  ```ts
  type PollResult =
    | { status: "items"; items: readonly unknown[]; cursor: SourceCursor; pollIntervalMs?: number }
    | { status: "not-modified"; pollIntervalMs?: number }
    | { status: "rate-limited"; retryAfterMs?: number }
    | { status: "failure"; error: unknown }
  ```
- **Pure bounded dedupe** (no accumulator loop):
  ```ts
  export const partitionFresh = <T,>(items: readonly T[], seen: ReadonlySet<string>, keyOf: (t: T) => string, cap = 1000) => {
    const fresh = items.filter(i => !seen.has(keyOf(i)))
    const nextSeen = new Set([...fresh.map(keyOf), ...seen].slice(0, cap))
    return { fresh, nextSeen }
  }
  ```
- **A cycle** (notifications shown; events analogous via `normalizeEventsApi`):
  ```ts
  export const runNotificationsCycle = (deps: NotificationsDeps) => async (): Promise<{ pollIntervalMs?: number }> => {
    const state = await deps.state.load()
    const res = await deps.notifications.poll(state.notifications)   // conditional GET
    const handlers: Record<PollResult["status"], () => Promise<{ pollIntervalMs?: number }>> = {
      "not-modified": async () => ({ pollIntervalMs: res.pollIntervalMs }),
      "rate-limited": async () => ({ pollIntervalMs: res.retryAfterMs }),
      "failure":      async () => { deps.log.error("notifications poll failed", { error: res.error }); return {} },
      "items":        async () => {
        const { fresh, nextSeen } = partitionFresh(res.items, state.notifications.seen, notificationKey)
        const events = fresh.map(deps.normalize).filter(Either.isRight).map(e => e.right)   // skip+log lefts separately
        const put = await deps.events.putEvents(events)
        if (put.status === "failure") { deps.log.error("notifications persist failed", { error: put.error }); return {} } // no cursor advance → retry
        await deps.state.save({ ...state, notifications: { ...res.cursor, seen: [...nextSeen] } })
        return { pollIntervalMs: res.pollIntervalMs }
      }
    }
    return handlers[res.status]()
  }
  ```
  **Advance the cursor/seen-set only after a successful persist** — a persist failure must not
  advance state, so the items are retried next cycle (no data loss).
- **Per-source enablement**: `daemon.start()` builds only the sources whose PAT is present; logs a
  clear "notifications source disabled (no classic PAT)" and continues with the other.
- **Shutdown**: one `AbortController`; `process.on("SIGINT"|"SIGTERM", () => controller.abort())`.

### Codebase irregularities to ignore
- The stub's "Open: volume vs S3 marker" is **resolved to S3 state** (see Notes). Follow the Plan.
- `aws.md`'s EC2/ALB guidance is irrelevant — this runs on **Railway**, not AWS compute; only the
  S3 write path touches AWS (via an IAM user's keys in Railway secrets).

### Step-by-step tasks

#### EXTEND `packages/github` for the Events API
- **IMPLEMENT**: `EventsApiItemSchema`, finalize `EventsApiTriggerSchema`, `normalizeEventsApi`,
  `events_api` mapping rules + `events-api-*.json` exemplars.
- **GOTCHA**: the `events_api` trigger's `matchKey` must align with the new JSON rules (same
  `type`/`action` field names); omit absent `action`.
- **VALIDATE**: `pnpm --filter @personal-events/github test` (events-api classifies; round-trips an exemplar)

#### CREATE poller skeleton + `config.ts` + `logger.ts` + pure `dedupe.ts`/`backoff.ts`
- **IMPLEMENT**: package/tsconfig/tsup/vitest; env Schema + per-source enablement; pure helpers.
- **VALIDATE**: `pnpm --filter @personal-events/github-poller test dedupe backoff config`

#### CREATE `github-http.ts` + `notifications-repository.ts` + `events-repository.ts`
- **IMPLEMENT**: conditional `fetch` helper + the two source repositories returning `PollResult`.
- **GOTCHA**: a `304` must read as `not-modified` (no items, **no rate-limit charge**); read
  `X-Poll-Interval` on **every** response (incl. 304) and honor it as the floor for the next delay.
- **VALIDATE**: `pnpm --filter @personal-events/github-poller test notifications-repository events-repository`
  (mock `fetch`: 200 with items+headers, 304, 429 with `Retry-After`, 5xx).

#### CREATE `poller-state-repository.ts`
- **IMPLEMENT**: S3 load (GetObject → parse; missing → empty initial state) + save (PutObject).
- **GOTCHA**: a missing state object on first run → seeded empty state (not an error); a malformed
  state object → log + start from empty (don't crash).
- **VALIDATE**: `pnpm --filter @personal-events/github-poller test poller-state-repository`

#### CREATE `notifications-cycle.ts` + `events-cycle.ts` + `source-poller.ts`
- **IMPLEMENT**: the cycle composition above + the self-scheduling loop.
- **GOTCHA**: advance cursor/seen-set **only** after successful persist; malformed items skipped+logged, not fatal.
- **VALIDATE**: `pnpm --filter @personal-events/github-poller test notifications-cycle events-cycle source-poller`

#### CREATE `daemon.ts` + `index.ts`
- **IMPLEMENT**: wire config→repos→start enabled sources; SIGINT/SIGTERM abort; per-source isolation.
- **VALIDATE**: `pnpm --filter @personal-events/github-poller build && node dist/index.js` (with a
  fake/short-lived config) starts both loops and shuts down cleanly on SIGINT.

#### EXTEND Terraform (`github-poller-iam.tf`) + Railway setup note
- **IMPLEMENT**: the least-priv IAM user/policy; a `setup.md` listing the Railway env/secrets
  (two PATs, AWS keys, bucket/region/state-key/intervals) and the classic-PAT requirement for Notifications.
- **VALIDATE**: `terraform -chdir=infra/personal-events plan` clean; `test -f apps/github-poller/setup.md`.

### Testing strategy
- **Unit** (vitest, mock `fetch`/S3): `dedupe` (fresh vs seen, bounded cap, restart simulation),
  `backoff` (honors `X-Poll-Interval`/`Retry-After`, caps growth), `config` (per-source
  enablement), each repository (200/304/429/5xx → correct `PollResult`; conditional headers sent),
  `poller-state-repository` (missing/malformed → empty), each cycle (items→events→persist→state;
  persist failure → **no** cursor advance; malformed item skipped+logged; cross-source overlap →
  two distinct events).
- **Integration** (real GitHub + real S3, per `.agents/tests.md`): with real test PATs, one live
  Notifications poll and one Events poll write objects to a test bucket prefix; a second poll
  immediately after yields **no** new objects (304 / dedupe). Tear down by key.
- **Edge cases**: only one PAT present → only that source runs, the other logs disabled; invalid
  PAT → 401 → that source backs off, process stays up; restart mid-run → resumes from S3 state, no
  re-notify; a `since` cursor advances so the inbox isn't re-scanned from the beginning.

### Validation commands
- Level 1: `pnpm --filter @personal-events/github-poller exec biome check src`
- Level 2: `pnpm --filter @personal-events/github-poller typecheck`
- Level 3: `pnpm --filter @personal-events/github-poller test`
- Level 4: local `node dist/index.js` against real test PATs writes to a test bucket; deploy to
  Railway, confirm logs show alternating 200/304 cycles and objects landing in S3.

## Plan refresh (2026-07-19) — what changed between planning and execution

| Planned assumption | Reality | Action |
| :--- | :--- | :--- |
| Poller state lives at `state/github-poller.json` **in the event bucket** | **this would have been a silent, total outage** — see below | The state object lives in the separate operational-state bucket AWE-156 introduced |
| Two files, `notifications-cycle.ts` and `events-cycle.ts` | the two cycles differ in exactly three pure functions | One generic `source-cycle.ts` plus a `SourceDefinition` per source in `sources.ts`. Two near-identical cycle files would have drifted, and the invariant that matters (advance state only after a successful write) would then exist twice |
| `aws_iam_access_key` "with a sensitive output if acceptable for this personal project" | the state file lives in an S3 bucket more things can read than should see a credential | Terraform creates the **user and policy only**; the key is created out of band. The command is in `setup.md` |
| `.agents/frameworks/effect/…` API reference | `.agents/cache/effect/**` does not exist here | Verified against installed typings |
| `AWE-155's shared @personal-events/event-sink` | shipped as planned | Reused unchanged — identical event keys and write path as the webhook |

### ⚠️ The story's state-object location was the same silent-total-loss bug as AWE-156's

`state/github-poller.json` in the **event bucket** would have stranded the desktop notifier exactly
as delivery markers would have: `apps/desktop-notifier/src/poller.ts` lists that bucket with
`StartAfter` and **no prefix filter**, and advances its mark to the highest key seen. `"state/…"`
begins with `s`, which sorts above every digit, so the first poll to see it would push the consumer's
mark above every `"2026-…"` event key that will ever exist. Both stories are fixed by the same
separate bucket; the reasoning is recorded in `poller-state-repository.ts`, the Terraform, and
`infra/README.md`.

### 🐛 A real defect found by running the built binary, not by any spec

The loop's default scheduler was `setTimeout(...).unref()`. An `unref`'d timer does not keep the
event loop alive — and between polls that timer is the *only* handle a healthy poller holds. So the
process **ran exactly one cycle per source and then exited**, with a log that looks like success: a
clean startup, one `polled` line, no error at all.

Reproduced against the built binary (`node apps/github-poller/dist/index.js`), fixed, and re-verified
both ways: the process now stays alive across several cycles, **and** stops promptly on `SIGTERM`
rather than lingering for up to `maxBackoffMs` (fifteen minutes — long enough for Railway to
`SIGKILL` a service that was trying to exit politely). The scheduler now clears its pending timer on
abort. Both halves and the reasoning are in `source-poller.ts`'s docblock.

This is the argument for `.agents/tests.md`'s *"if it's a script, run the script"* rule: no unit spec
would have caught it, because every spec injects its own scheduler.

### Other design decisions taken during implementation

- **A missing token disables a source, never the process.** The two endpoints need different
  credential *types* — `GET /notifications` accepts a **classic** PAT only, not a fine-grained one
  and not an App token — so a user plausibly holds one and not the other. Refusing to start would
  take away the working half.
- **`X-Poll-Interval` is read from every response including a 304**, and `nextDelayMs` takes the
  **largest** of {base interval, poll interval, retry-after, back-off} rather than a priority order,
  so no signal can be accidentally suppressed by another. A `Retry-After` longer than the configured
  ceiling is obeyed — waiting less would be disobeying the API.
- **A cursor is only ever widened.** A 200 that omits the header it usually sends must not clear a
  cursor we already had, or the next poll re-fetches unconditionally at full rate-limit price.
- **A 403 is only a rate limit when the budget is actually exhausted** (`x-ratelimit-remaining: 0`
  or a `retry-after`). A plain 403 is a permission problem and must not be retried as throttling.
- **A malformed item is skipped, logged with its id, and does not hold up its siblings**; a *write*
  failure does not advance the cursor at all, so those items are retried.
- **The notification `since` cursor advances only to the newest `updated_at` actually seen**, and
  the dedupe set — not the cursor — is what prevents re-delivery. Advancing past what was seen would
  skip an item updated in the same second.
- ~~**The Events API path does not share the notifications timestamp hazard**~~ — **this claim was
  wrong and is corrected (R1-3).** An activity item does carry its own `created_at` rather than an
  injected clock, but GitHub emits it at **second** precision, exactly like the inbox's `updated_at`
  — this package's own exemplars show it (`events-api-push.json`: `"2026-07-19T19:14:52Z"`). Two
  items created in the same second therefore normalise to the same millisecond, and the `events_api`
  channel is inside the scope of `feature.md` § Follow-up candidates #1 and #3. Only the webhook path
  escapes, because its `receivedAt` is an injected `new Date().toISOString()`.

## Re-architecture (2026-07-21): Railway container → EventBridge-scheduled Lambda

The platform became **AWS-only** (`system.md`), so this story was re-architected from a long-running
Railway container to an **EventBridge-scheduled Lambda** (`rate(1 minute)`). Everything below the
frontmatter that says "Railway", "daemon", "self-scheduling loop", "container", or "IAM user" is the
*original* plan; the shipped shape is:

- The **handler is one poll cycle** — load state, poll each source, save state — with EventBridge as
  the cadence. No `source-poller.ts` loop, no `backoff.ts`, no `Dockerfile`/`railway.json`. This also
  **mooted the R1-4 concurrent-cursor-clobber**: a scheduled Lambda with
  `reserved_concurrent_executions = 1` has no concurrent loops, so the single combined state object
  is safe.
- State (per-source cursor + dedupe set + a `notBefore` that honours `X-Poll-Interval`/`Retry-After`)
  lives in **one S3 object** in the operational-state bucket, read once and written once per
  invocation.
- The two PATs live in **SSM SecureStrings** (aligned with the webhook secret), read fresh each
  invocation. A token that cannot be read disables its own source and leaves the other running.
- Terraform is `github-poller.tf` (Lambda + EventBridge rule + two SSM params + a least-privilege
  **IAM role**, not a user — no long-lived keys). R1-7's bad `s3:prefix` condition is gone.

## Deferred verification — NOT met under the code-and-dry-run fence

The fence forbids `terraform apply`, creating AWS resources, deploying a Lambda, and calling the live
GitHub API with a real PAT. These criteria are **unverified** — not failed, untested.

| Acceptance criterion | Status | Command or step the user must run to close it |
| :--- | :--- | :--- |
| The deployed Lambda runs and reaches its first `poll complete` | **Unverified** | `pnpm --filter @personal-events/github-poller build && terraform -chdir=infra/personal-events apply -var github_username=<login>`, set the two SSM PATs (`apps/github-poller/setup.md` § 1), then `aws lambda invoke --function-name "$(terraform -chdir=infra/personal-events output -raw github_poller_function_name)" /dev/stdout` and check the log for `poll complete` |
| A real Notifications poll ingests inbox items into S3 | **Unverified** | set the classic PAT param, invoke, and look for a `polled` line with `written > 0`, then `aws s3 ls s3://$(…event_bucket_name)/` |
| A real Events API poll ingests activity items into S3 | **Unverified** | set the events PAT param + `github_username`, invoke, same check |
| A second invocation yields **no** new objects (304 / dedupe) | **Unverified** | invoke twice; expect `nothing new` at `debug`, or `fetched > 0, fresh: 0` |
| EventBridge actually fires the Lambda on schedule | **Unverified** | wait a few minutes after apply and confirm periodic invocations in the function's CloudWatch logs without manual `invoke` |
| The classic-PAT constraint is real (a fine-grained PAT cannot call `/notifications`) | **Unverified** | put a **fine-grained** token in the notifications param and confirm `poll failed` HTTP 401/403 — documented from GitHub's docs, not exercised |
| Rate-limit handling against a real 429 | **Unverified** | not reproducible on demand; covered by unit specs over scripted responses |
| The IAM role is sufficient and not excessive | **Unverified** | after apply, confirm a poll writes an event and that the role cannot `GetObject` an event key (write-only) |
| Restart/redeploy resumes from S3 state without re-notifying | **Unverified** | redeploy and confirm the next invocation reports `fresh: 0` |
| `reserved_concurrent_executions = 1` prevents overlap | **Unverified** | `aws lambda get-function-concurrency` returns 1 |

**No AWS resource was created. No PAT was requested, invented, or used. No call was made to
api.github.com. Nothing was deployed.**

### What WAS verified (current, post-re-architecture)

- **89 specs** over the scheduled-Lambda poller, covering: the per-source cycle (pure over
  `SourceState`, returning next-state + outcome); conditional headers per dialect;
  200/304/401/403-with-budget/403-throttled/429/5xx/non-array-body/transport-error → the right
  `PollResult`; `X-Poll-Interval`/`Retry-After` becoming a `notBefore` and `isDue` skipping until it
  passes; a cursor not cleared by a 200 that omits it; dedupe across cycles and a simulated restart;
  the bounded seen-set evicting oldest-first; **a write failure returning the unchanged state so the
  cursor never advances past an unwritten event**; a malformed item skipped while its siblings are
  written; the two sources' state branches staying independent through `pollOnce`; token resolution
  from SSM with a failed read disabling only its own source; and a **`bundle.spec.ts`** that imports
  the emitted `handler.js` from a directory with no `node_modules` (catching a broken Lambda zip).
- **The Lambda's composition root was exercised** (`composition.spec.ts`, `poll-once.spec.ts`) with
  faked S3/SSM clients and an injected clock — no timers, no network — including per-source
  enablement and the bucket-probe *report* (reachable / unreachable / inconclusive).
- **`terraform fmt -check -recursive`** clean, **`validate` Success** on both roots, and a real
  scratch `plan`: **`Plan: 41 to add, 0 to change, 0 to destroy`**. Nothing applied.

> **Superseded history (original Railway design).** The first pass built a long-running daemon and
> found an `unref()` defect by running the built binary under four configurations; that binary,
> its self-scheduling loop, its `SIGTERM` shutdown, and the "99 specs" that covered them **no longer
> exist** — the re-architecture (above) replaced them with a Lambda handler. Kept here only so the
> record of *how* the defect was found is not lost; it is not evidence for the shipped code.

### Validation actually run (current)

| Level | Command | Result |
| :--- | :--- | :--- |
| 1 — style | `pnpm --filter @personal-events/github-poller lint` | clean |
| 2 — types | `pnpm --filter @personal-events/github-poller typecheck` | clean |
| 3 — specs | `pnpm --filter @personal-events/github-poller test` | 89 passed |
| 4 — artifact | `bundle.spec.ts` imports the emitted `handler.js` from a dir with no `node_modules` | passes |
| 4 — infra | `fmt -check`, `validate` both roots, scratch `plan` | clean / Success / 41 to add |
