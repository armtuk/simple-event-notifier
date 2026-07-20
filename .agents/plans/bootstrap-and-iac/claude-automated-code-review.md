# Claude automated code review — `bootstrap-and-iac`

Audit trail for independent (R1+) review passes over the feature branch. Newest section last.

## R1 — 2026-07-19

**Reviewer:** independent R1 (fresh eyes, did not write the code)
**Diff reviewed:** `git diff auto/execute-remaining-bootstrap-github..feat/bootstrap-and-iac` — 94 files, ~5858 insertions
**Stories in scope:** AWE-149 `monorepo-bootstrap.md`, AWE-150 `event-model-package.md`, AWE-151 `infra-s3-and-dns.md`, AWE-152 `desktop-notifier-daemon.md`
**Guidance loaded:** `.agents/general.md`, `formatting.md`, `tests.md`, `languages/typescript/{typescript,typescript-testing,object-types-typescript}.md`, `frameworks/node/preferences.md`, `frameworks/effect/effect.md`, `guidance/{aws,logging}.md`, `code-examples/typescript/src/looping.ts`

### Verdict

**Findings — 1 blocker, 6 major, 8 minor, 3 nits.**

This is a well-shaped, unusually disciplined bootstrap. Gather/Compute/Persist is real and visible at
module level (`poller` → `classify`/`notification-content` → `notify`/`state`), the no-accumulator-loop
rule is honoured everywhere (`reduce` for the mark, `reduce`-threaded promise chain for ordered
delivery, `Object.fromEntries` in `config.ts`), there are no enums, no `function` keyword, no trailing
semicolons, no file over 125 lines, and every fallible entry point returns `Either` or a tagged union
rather than `null`. The AWE-151/AWE-152 `## Deferred verification` sections are accurate and unusually
honest about the code-and-dry-run fence.

The blocker is a real data-loss bug in the load-bearing contract, not a style issue.

### Independent verification performed

| Check | Result |
| :--- | :--- |
| `npx vitest run` | 119 passed, 5 skipped (12 files) — matches `feature.md`'s claim |
| `npx biome check .` | clean, 56 files |
| `tsc --noEmit` in both TS members | clean |
| `terraform fmt -check -recursive` in both modules | clean |
| Diff scanned for `.claude/`, `AGENTS.md`, `.env`, keys, `AKIA…`, `BEGIN …PRIVATE KEY` | **none present** |
| Diff scanned for executed `terraform apply` side effects | **none** — every `apply` occurrence is documentation or an npm script |
| Codec probed directly against the built `dist/index.js` | see findings 1, 3, 5, 10, 11 |

---

### Findings

#### 1. BLOCKER — variable-precision ISO timestamps break the key sort order the whole system rests on

`packages/event-model/src/event.ts:24`

```
export const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
```

The fractional-seconds group is **optional and variable-width**. `system.md` and
`packages/event-model/src/event-key.ts:6-12` both state the invariant the design depends on: *"The
leading ISO instant makes the bucket sort chronologically by key, which is what lets a consumer treat
'the last key I processed' as a high-water mark."* That invariant does not hold under this pattern,
because `.` (0x2E) sorts **below** every digit and `Z` (0x5A) sorts **above** every digit:

```
"2026-07-19T09:15:02Z.alert…"      >  "2026-07-19T09:15:02.500Z.alert…"   // 500ms EARLIER sorts first ✗
"2026-07-19T09:15:02.12Z.alert…"   >  "2026-07-19T09:15:02.123Z.alert…"   // 120ms EARLIER sorts last ✗
```

(Verified in node.) This is not hypothetical: the two committed valid exemplars use **different
precisions** — `valid-github-pull-request.json` has `2026-06-28T18:44:30.123Z`, and
`valid-agent-notification.json` has `2026-07-19T09:15:02Z` — and `event-key.spec.ts:48` explicitly
pins "recovers a millisecond-less timestamp" as supported behaviour.

Failure scenario: a producer writes `…T09:15:02Z…` (no fraction) at 09:15:02.000 and another writes
`…T09:15:02.400Z…` at 09:15:02.400. `advanceMark` (`poller.ts:27`) takes the lexicographic max, so the
mark jumps to the `…02Z…` key. `ListObjectsV2 StartAfter` is exclusive and lexicographic, so the
`.400Z` event is **never returned again**. It is permanently un-notified, and `state.json` records the
skip across restarts. For a system whose S3 bucket is the permanent source of record, this is silent
event loss.

**Proposed fix:** make the fraction mandatory and fixed at three digits, matching
`Date.prototype.toISOString()` (which `seedMark` already produces):
`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`, and mirror it in `eventKeyPattern`. Update
`valid-agent-notification.json` to `2026-07-19T09:15:02.000Z`, delete the "millisecond-less" spec, and
add a spec asserting lexicographic order equals chronological order across a table of mixed-precision
instants. Because this is a versioned contract with no production data yet, fixing it now is free;
fixing it after the first `terraform apply` is a history migration (the ADR itself calls the key scheme
a one-way door).

#### 2. MAJOR — `runDaemon` recurses through an awaited promise chain, so a long-running daemon retains one frame per tick forever

`apps/desktop-notifier/src/daemon.ts:33-45`

```ts
const next = await runTick(dependencies, initial)
await delay(nextDelayMs(schedule, next.consecutiveErrors), signal)
return signal.aborted ? next : runDaemon(dependencies, schedule, next, signal)
```

Returning the recursive call from an `async` function chains promises: `P0` only settles when `P1`
settles, which only settles when `P2` settles… Nothing is tail-call optimised, so after *N* ticks *N*
pending promises and *N* async frames (each closing over `dependencies`, `schedule`, `next`, `signal`)
are retained. At the default 30 s interval that is ~2 880 retained frames/day, unbounded for the life
of the process — and this is explicitly a *long-running* daemon.

It is also an unrecorded deviation from the plan. AWE-152's resolved decision reads: *"Poll model: a
self-scheduling async tick (recursive `setTimeout`, NOT `setInterval`) so ticks never overlap."* The
implementation is a recursive `await` chain with a `delay()` promise, not a self-scheduling timer, and
the "Execution notes" section does not mention the change.

**Proposed fix:** schedule the next tick from inside the timer callback so each tick's promise settles
independently and the stack unwinds:

```ts
export const runDaemon = async (dependencies: DaemonDependencies, schedule: DaemonSchedule, initial: TickState, signal: AbortSignal): Promise<TickState> =>
  new Promise<TickState>(resolve => {
    const scheduleNext = (state: TickState): void => {
      if (signal.aborted) { resolve(state); return }
      const timer = setTimeout(() => { void runTick(dependencies, state).then(scheduleNext) }, nextDelayMs(schedule, state.consecutiveErrors))
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(state) }, { once: true })
    }
    scheduleNext(initial)
  })
```

The existing `runDaemon` specs (abort-before-start, abort-mid-run) carry over unchanged.

#### 3. MAJOR (honesty + correctness) — an unknown `eventType` produces a generic structural error; AWE-150's execution note claims the opposite

`packages/event-model/src/event-key.ts:54,61-67`; `.agents/plans/bootstrap-and-iac/event-model-package.md:247-250`

The plan's execution note asserts:

> **Key regex captures the type segment as `[^.]+`, not `(alert|notification)`**, and resolves it
> through a `Partial<Record<string, EventType>>` lookup. Baking the alternation into the regex made an
> unknown type look like a structurally malformed key; **this way the failure message names
> `eventType`.**

It does not. `matchKey` resolves `eventTypeByName[rawEventType]` **eagerly** and folds an unresolved
type into the same `Either.left` as a structurally broken key. Verified against the built package:

```
parseKey("2026-06-28T18:44:30.123Z.warning.p5.github.x.json")
→ Invalid event object key "…": EventKeyFromString
  └─ Transformation process failure
     └─ expected {timestamp}.{alert|notification}.p{priority}.{source}.{name}.json with no "." inside …
```

The word `eventType` never appears, and the message describes a *shape* problem for what is a *value*
problem. Contrast the priority path, which genuinely is left loose and does produce the intended
message (`["priority"] └─ Priority └─ … actual 9`). `event-key.spec.ts:22,54-60` does not catch this
because it only asserts the message contains the key string.

**Proposed fix:** drop `eventTypeByName` and let the schema reject the value — capture the segment as
a plain string and cast at the boundary, e.g. `Either.right({ …, eventType: rawEventType as EventType, … })`
with a comment that `EventTypeSchema` is the actual gate. Then tighten the spec's unknown-type row to
`expect(error.message).toContain("eventType")`, and correct the execution note (or delete the claim).

#### 4. MAJOR (guidance-violation) — no bucket pre-flight check at startup

`apps/desktop-notifier/src/index.ts:24-54`, `apps/desktop-notifier/src/s3-client.ts`

`.agents/guidance/aws.md` § S3 § Usage in Code:

> *"Whenever an S3 bucket is used in code, a pre-flight check should be performed to ensure the bucket
> exists at the time the service which uses that bucket starts up."*

`start()` probes credentials eagerly (good, and exactly the right shape) but never probes the bucket.
AWE-152's own "What WAS verified locally" confirms the resulting behaviour: a typo'd `EVENT_BUCKET`
does not fail fast — the daemon starts, logs `Poll failed; backing off before the next attempt` every
tick, ramps to the 5-minute ceiling, and runs forever notifying nobody. A user who mistypes the bucket
gets a process that looks healthy.

**Proposed fix:** add `probeBucket = async (s3: S3Client, bucket: string): Promise<BucketProbeResult>`
to `s3-client.ts` using `HeadBucketCommand`, returning the same tagged-union shape as
`probeCredentials`, and gate `start()` on it with a `logger.error` naming the bucket and region before
returning exit code 1. Mirrors the credential probe exactly, so it costs one function and one `if`.

#### 5. MAJOR — `Schema.URL` for `workItem` is not a byte-stable codec, and the round-trip spec only passes because the exemplar URL happens to be normalized

`packages/event-model/src/event.ts:57`; `packages/event-model/src/parse.spec.ts:77-86`

`event.ts:23` takes deliberate care over exactly this concern for the timestamp — *"Stored as the
literal string so the object key and the body agree byte-for-byte"* — but `workItem` uses
`Schema.URL`, whose encode is `url.toString()`. `URL` normalizes. Verified:

```
"https://github.com"        → "https://github.com/"      CHANGED (trailing slash)
"HTTPS://GitHub.com/Foo"    → "https://github.com/Foo"   CHANGED (scheme + host lowercased)
```

`parse.spec.ts` claims *"round-trips %s byte-for-byte through decode → encode"*, but the only exemplar
with a `workItem` is `https://www.jira.com/browse/AWE-150`, which is already in normal form — so the
spec asserts a property the codec does not have. With S3 as the permanent source of record, any
producer or triage client that does `parseEvent → mutate acknowledged → encodeEvent → PutObject` will
silently rewrite the stored `workItem` bytes.

There is a second, smaller cost: `Event.workItem` is a `URL` **instance**, so a downstream consumer
that writes `event.workItem === someString` or `typeof event.workItem === "string"` gets a silently
wrong answer. `notification-content.ts:25` already has to reach for `.href`.

**Proposed fix (pick one, and say which in the ADR/README):**
- *Preferred for a permanent record:* store the string and validate the shape —
  `workItem: Schema.optionalWith(Schema.String.pipe(Schema.filter(isParseableUrl, { identifier: "WorkItemUrl" })), { exact: true })`. Encode becomes identity; consumers get a `string`.
- *If the `URL` instance is genuinely wanted:* keep `Schema.URL` but add a spec with a
  **non-normalized** input (`https://github.com`) asserting the documented normalization, and state in
  `packages/event-model/README.md` that `workItem` is normalized on decode so producers must write the
  normal form.

#### 6. MAJOR (test-coverage) — no spec asserts any log line, yet `feature.md` marks "a malformed object is logged and skipped" as **Met**

`apps/desktop-notifier/src/daemon.spec.ts:32,61-72`; `.agents/plans/bootstrap-and-iac/feature.md:140`

`.agents/tests.md` § Tests and Test data is explicit, twice:

> *"Spec testing for this must include validation that logging occurred and showed records were
> successfully processed, ingested, received or otherwise."*
> *"Ensure the correct errors are reported, ensure that any logging shows the full error message that
> can be read and understood and show why a particular record failed, enable identification of which
> record failed…"*

Every daemon spec injects `silentLogger()` (`createDaemonLogger({ level: "error" })`) and asserts only
the returned `TickState` and the recorded notifications. Nothing asserts that
`"Skipping unparseable event object"` was emitted, that it carried `key`, or that `reason` names the
offending field. The *skipping* is tested; the *logging* — which is the entire user-visible failure
signal, and the acceptance criterion as worded — is not. `feature.md:140` nonetheless records **Met**.

**Proposed fix:** add a capturing winston transport in the spec and assert on it:

```ts
const captured: Record<string, unknown>[] = []
class Capture extends Transport { log(info: Record<string, unknown>, next: () => void): void { captured.push(info); next() } }
```

Then assert one entry with `level: "warn"`, `message: "Skipping unparseable event object"`,
`key === badKey`, and `reason` containing `"priority"`; and one `info` entry
`"Raised desktop notification"` per delivered event. Downgrade `feature.md:140` to reference the new
spec once it exists.

#### 7. MAJOR (dry-wet) — event exemplars and their loader are copy-pasted across workspace members

`apps/desktop-notifier/exemplars/*.json` vs `packages/event-model/exemplars/*.json`;
`apps/desktop-notifier/src/testing/exemplars.ts` vs `packages/event-model/src/testing/exemplars.ts`

Three exemplar files are **byte-identical** across the two members (verified with `diff`):
`valid-agent-notification.json`, `valid-github-pull-request.json`, `invalid-priority-out-of-range.json`.
The two loader modules differ only in `"utf8"` vs `"utf-8"` and in whether they `JSON.parse`.

These files *are the contract*. `.agents/general.md` calls the event model "the load-bearing contract…
treat it as a versioned interface"; duplicating its canonical test data into a consumer means the copy
can silently drift, and the consumer's suite would keep passing against a stale contract — precisely
the failure the shared package exists to prevent. This is exactly the duplication the review brief
asks to be hunted, and it is the clearest instance in the diff.

**Proposed fix:** make the exemplars a published artefact of `@personal-events/event-model` — add
`"./exemplars/*": "./exemplars/*"` (or `"./testing"`) to its `exports`, add `"exemplars"` to `files`,
delete `apps/desktop-notifier/exemplars/{valid-*,invalid-priority-out-of-range}.json`, and have the
app's loader resolve through the package. Keep only `not-json.txt` locally — it is genuinely a
desktop-notifier concern (a non-event object in the bucket), not an event-model one. Move
`readExemplarText`/`readExemplar`/`readExemplarEvent` into one exported test-support module.

#### 8. MINOR (dry-wet) — the six-resource hardened-bucket block is duplicated between the two Terraform root modules

`infra/bootstrap/state-bucket.tf` vs `infra/personal-events/s3.tf` (plus identical `versions.tf` and
near-identical `providers.tf` and `locals.tf`)

Both modules declare the same set with the same arguments: `aws_s3_bucket` (`force_destroy = false`),
`aws_s3_bucket_public_access_block` (all four flags true), `aws_s3_bucket_ownership_controls`
(`BucketOwnerEnforced`), `aws_s3_bucket_versioning` (Enabled),
`aws_s3_bucket_server_side_encryption_configuration` (AES256 + bucket key), and an
`abort-incomplete-uploads` lifecycle rule at 7 days. Only the lifecycle *retention* rules genuinely
differ. `versions.tf` is byte-identical.

`.agents/general.md` § "Separation applies at the module/file level" — the *axis of change* here is
"how we harden an S3 bucket", and it currently changes in two places.

**Proposed fix:** extract `infra/modules/hardened-bucket/` taking `bucket_name` and a
`lifecycle_rules` input, and have both roots call it. If the bootstrap module is deliberately kept
self-contained so it can run before anything else exists, say so in a comment in `state-bucket.tf` —
a local module directory has no such bootstrapping constraint, so the duplication needs a stated
reason to stand.

#### 9. MINOR (dry-wet) — `describeCause` is copy-pasted five times

`packages/event-model/src/parse.ts:32`, `apps/desktop-notifier/src/{daemon.ts:113,state.ts:65,notify.ts:125,s3-client.ts:29}`

Character-for-character identical in all five:
`const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))`.

Well past the rule of three, and it is the single function that decides whether an operator can read
a failure — if it ever needs to grow (unwrap `cause.cause`, include `error.name`, truncate), it has to
grow in five places.

**Proposed fix:** one `apps/desktop-notifier/src/describe-cause.ts` for the four app copies, and
export a `describeCause` from `@personal-events/event-model` (it is already the package that owns
turning arbitrary failures into readable messages) for the fifth — or simply have the app import the
package's.

#### 10. MINOR — key decode is not injective: `p05` decodes to priority 5 and re-encodes as `p5`

`packages/event-model/src/event-key.ts:19,67`

`p(\d+)` + `Number.parseInt` accepts zero-padded and arbitrarily long digit runs. Verified:

```
parseKey("2026-06-28T18:44:30.123Z.alert.p05.github.x.json") → priority 5
buildKey(…)                                                  → "…alert.p5.github.x.json"   ≠ input
```

So two distinct S3 keys denote the same event, and `key → components → key` is not the identity that
`event-key.spec.ts:75-77` claims to pin (it only tests the already-canonical key). Feature acceptance
criterion "round-trips event ⇄ object-key" is therefore only true for keys this codebase produced.

**Proposed fix:** tighten the capture to a single digit — `\.p([1-8])\.` is the honest expression of
`priorityBounds`, or `\.p([1-9]\d?)\.` if you want the schema to keep producing the range message.
Add a spec asserting `parseKey("…p05…")` is a `Left`.

#### 11. MINOR — the schema accepts values that cannot survive the key contract

`packages/event-model/src/event.ts:21,24`

- `isoInstantPattern` is shape-only, so **impossible instants pass**. Verified:
  `parseEvent({… timestamp: "2026-13-45T99:99:99Z" …})` → `Right`. Month 13, day 45, hour 99 are stored
  as permanent history and will `NaN` in any consumer that does `new Date(event.timestamp)`.
- `noDotPattern` (`/^[^.]+$/`) forbids only `.`. `source`/`name` may therefore contain `/` (verified:
  `name: "b/c"` accepted), spaces, newlines, and control characters. A `/` silently turns the object
  key into a **prefix**, which changes how the bucket is listed and browsed.

**Proposed fix:** add a `Schema.filter` to `IsoInstant` asserting
`new Date(s).toISOString() === s` (once #1 pins the precision to 3 digits this is an exact
round-trip check and costs nothing); tighten `noDotPattern` to a safe key-segment charset such as
`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`, which is what the exemplars and the README's examples already use.

#### 12. MINOR — the mark advances past events whose *notification* failed, so delivery is at-most-once with no quarantine

`apps/desktop-notifier/src/daemon.ts:52-57,79-87`; `apps/desktop-notifier/src/poller.ts:26-28`

This is the item flagged for scrutiny, and the answer is: advancing past *unparseable* objects is the
right call and is correctly justified in the comment — the object stays in S3 (the source of record is
never damaged), it is logged at `warn` with key and reason, and the alternative is a poison pill that
stalls every later event forever.

But the same `advanceMark` result is used unconditionally, so a **valid** event whose notification
fails is also permanently skipped. Combined with `fallbackNotifier`'s latch (`notify.ts:68-86`), a
machine where both `toasted-notifier` and the shell adapter are unusable — headless session, missing
`notify-send`, a TCC-denied `osascript` — logs `Could not raise desktop notification` for every event
and drops all of them, with no way to replay. There is also no DLQ/quarantine anywhere, which
`.agents/tests.md` names as a thing to assert on (*"validating that records show up in any DLQ folder,
table, queue or location"*).

**Proposed fix (small, sufficient for this feature):** have `runTick` compute the mark as the highest
key that was either delivered **or** rejected-as-unparseable, excluding keys whose notify returned
`NotifyFailure`, so a transient/notifier-side failure is retried on the next tick. Longer term, record
rejected keys in the state file under `rejected: string[]` (or write a marker object under a
`quarantine/` prefix) so a bad object is discoverable after the log line has rotated away — worth a
follow-up story rather than blocking this merge.

#### 13. MINOR — `logLevel` and `env` are validated as bare non-empty strings, and unknown values fail silently

`apps/desktop-notifier/src/config.ts:31,34`; `apps/desktop-notifier/src/logger.ts:47`

Both have closed value sets, and `config.ts` already demonstrates the right pattern one line below
(`notifier: Schema.Literal(...)`, with a spec asserting `carrier-pigeon` is rejected). As written:

- `ENV=production` (a very plausible typo for `prod`) passes validation, then
  `resolveEnv` silently maps it to `"dev"` — so every shipped log record is stamped with the wrong
  environment, which `.agents/guidance/logging.md` requires to be one of `["dev","qa","stage","prod"]`.
- `LOG_LEVEL=verbse` passes validation and is handed to winston as a level that does not exist in the
  npm level set, so the daemon runs and emits **nothing**.

**Proposed fix:** `env: Schema.Literal("dev", "qa", "stage", "prod")` and
`logLevel: Schema.Literal("error", "warn", "info", "debug")`, which also lets `resolveEnv` and its
`deploymentEnvByName` lookup disappear entirely.

#### 14. MINOR (guidance-violation) — slice-don't-dump: `deliverAll`/`deliverOne` take the whole `DaemonDependencies`

`apps/desktop-notifier/src/daemon.ts:76,79`

`.agents/general.md` § "Slice, don't dump":

> *"Functions should receive specific slices of an aggregate as parameters, tailored to exactly what
> they require; do not pass the entire aggregate UNLESS the dependent function strictly requires it."*

`deliverOne` destructures `{ notifier, logger }` in its signature, but the *parameter type* is still
the full aggregate — so it accepts (and any future edit may reach into) `s3`, `bucket`, and
`stateFile`. Destructuring at the call boundary is not the same as narrowing the type. AWE-152's own
execution notes claim this rule was applied (`toNotification` takes only the `Event`, `daemon.ts`
receives a sliced `DaemonSchedule`) — it just was not applied one level down.

**Proposed fix:** declare `interface Delivery { readonly notifier: NotifierAdapter; readonly logger: Logger }`
and have `deliverAll`/`deliverOne` take that; `runTick` already destructures `dependencies` and can
pass `{ notifier, logger }`.

#### 15. MINOR — one tick fans out an unbounded `Promise.all` over every new key

`apps/desktop-notifier/src/poller.ts:20-23`

`listKeysAfter` materializes every page, then `Promise.all(keys.map(fetch))` issues one concurrent
`GetObject` per key with no ceiling. In steady state (first run seeds the mark to "now") this is a
handful. After a laptop has been asleep for a week, or on the first run of a `--backfill` flag the
plan anticipates, it is one concurrent request per object in the window — enough to hit SDK socket
limits and turn a recoverable catch-up into a whole-tick failure that resets nothing and backs off.

**Proposed fix:** cap the keys taken per tick (`keys.slice(0, maxObjectsPerTick)` — the mark advances
only over what was actually fetched, so the next tick simply continues), or chunk the fetch through a
`reduce`-threaded batch of `Promise.all` calls. `maxObjectsPerTick` belongs in `DaemonSchedule`.

#### 16. MINOR (docs) — `infra/README.md` claims the `validate` script is an offline check; it is not

`infra/README.md:28-29`; `infra/package.json`

> *"`-backend=false` skips remote-state initialization, so these work on a clean checkout. This is
> also what `pnpm --filter @personal-events/infra lint` and `… validate` run."*

The `validate` script is `terraform -chdir=personal-events validate` — no `init`, no `-backend=false`.
On a clean checkout (`.terraform/` is gitignored) it fails with *"Module not installed / Please run
terraform init"*. `lint` (`fmt -check`) is genuinely offline; `validate` is not.

**Proposed fix:** make the script honest —
`"validate": "terraform -chdir=personal-events init -backend=false -input=false && terraform -chdir=personal-events validate"`
— and do the same for `bootstrap`, which currently has no `validate` at all despite the story claiming
both modules validate.

#### 17. NIT — two deferred-verification commands omit `-chdir`

`.agents/plans/bootstrap-and-iac/infra-s3-and-dns.md:269-270`

`terraform plan -var parent_zone_name=does-not-exist.example` and `AWS_PROFILE=nope terraform plan`
will fail from the repo root for the wrong reason (no configuration). Every other row in the table
correctly carries `-chdir=infra/personal-events`. Since this table is the hand-off the user works
from, make it copy-pasteable.

#### 18. NIT — `feature.md`'s failure-mode row is broader than AWE-152 supports

`.agents/plans/bootstrap-and-iac/feature.md:141`

> *"Missing AWS credentials, an unreachable bucket, and an unparseable object each produce a clear log
> line rather than a crash | **Met** — all three exercised against the built daemon locally"*

AWE-152's own "What WAS verified locally" lists missing credentials, unreachable bucket, and missing
config as run against the daemon, but puts *"Malformed object handling … covered by the unit suite
against the fake S3 transport"* in a separate sentence. Only two of the three were exercised against
the built daemon. Everything else in these deferred sections was accurate and carefully hedged, so
this reads as a summarising slip rather than a claim — but the feature file is the row a reader trusts.

**Proposed fix:** *"Met — credentials and bucket failures exercised against the built daemon; the
unparseable-object path against the real poller code path in the unit suite."*

#### 19. NIT — fall-through guard `if`s

`daemon.ts:39`, `index.ts:17,29`, `notify.ts:73,79`

`.agents/languages/typescript/typescript.md`: *"Avoid fall-through if statements, always use if AND
else."* All five sites are early-return guard clauses, which is the most defensible form of the
pattern, and rewriting them as `if/else` would arguably read worse. Recording it because the rule is
stated unconditionally; recommend either accepting these as an explicit carve-out in `CLAUDE.md`
(*"guard clauses that return are exempt"*) or converting them. What should **not** happen is the rule
quietly eroding across future files.

#### 20. NIT — dotted S3 bucket names force path-style addressing

`infra/personal-events/locals.tf:5`

`events.prod.personal-events.fifthdimensionengineering.com` follows `.agents/guidance/aws.md`'s
`{usage}.{env}.{system}.{domain}` convention exactly, so this is not a deviation. Flagging only so it
is a known, chosen trade-off: a bucket name containing dots cannot use virtual-hosted-style HTTPS
(the `*.s3.<region>.amazonaws.com` wildcard certificate does not match multi-label names), so the SDK
falls back to path-style addressing, and it rules out a same-name CloudFront/website origin later
without a separate alias. No action needed now; worth a line in the ADR's trade-offs.

---

### DRY vs WET assessment

Duplication was hunted specifically across (a) `packages/event-model` ↔ `apps/desktop-notifier`,
(b) workspace tooling config, (c) Terraform, and (d) test scaffolding.

**Real duplication found — three instances, all with concrete resolutions:**

| # | Duplication | Where | Resolution |
| :-- | :--- | :--- | :--- |
| 7 | Three **byte-identical** exemplar JSON files plus two near-identical `testing/exemplars.ts` loaders | `apps/desktop-notifier/exemplars/` ↔ `packages/event-model/exemplars/` | Publish the exemplars from `@personal-events/event-model` via an `./exemplars/*` subpath export + `files: ["dist","exemplars"]`; delete the app's copies (keep only `not-json.txt`, which is genuinely the app's concern); hoist the loader into one exported test-support module. Highest-value fix — this is the *contract's* test data and drift here is silent. |
| 8 | The six-resource hardened-bucket block, plus byte-identical `versions.tf` and near-identical `providers.tf`/`locals.tf` | `infra/bootstrap/state-bucket.tf` ↔ `infra/personal-events/s3.tf` | Extract `infra/modules/hardened-bucket/` parameterized by `bucket_name` + `lifecycle_rules`; both roots call it. Only the retention rules genuinely differ. |
| 9 | `describeCause`, character-for-character identical | 5 files across both members | One module in the app + export one from the event-model package; five copies is well past the rule of three, and it is the function that decides whether an operator can read a failure. |

**Near-misses examined and judged acceptable WET — no action recommended:**

- **Per-member `tsconfig.json` / `vitest.config.ts` / `tsup.config.ts`.** Structurally similar but each
  is three-to-seven lines, must exist per workspace member for the tooling to discover it, and they do
  differ meaningfully (`dts: true` vs `false`, the `#!/usr/bin/env node` banner, `types/**` in the app's
  include, different project names). The shared substance is already correctly hoisted to
  `tsconfig.base.json`, `biome.json`, root `vitest.config.ts`, and the `catalog:` block — which is the
  right factoring. Collapsing further would fight the tools.
- **Result-shape "boilerplate"** — `NotifyResult`, `LoadStateResult`, `CredentialProbeResult`,
  `ClassifiedObject`, `EventModelError` all follow the same `_tag`ged-union pattern. This is a *shape*
  repeated, not *logic* duplicated; each has genuinely different members and a different axis of change.
  Correct as-is; abstracting it behind a generic would lose the named failure modes the guidance asks
  for.
- **`eventTypeByName` (`event-key.ts:54`) and `deploymentEnvByName` (`logger.ts:14`)** — the same
  `Partial<Record<string, T>>` lookup idiom in two packages. Two occurrences of a three-token idiom,
  different domains, no shared abstraction worth the coupling. (Note that finding #3 removes the first
  and finding #13 removes the second anyway.)
- **The `filter`-by-`_tag` pair `parsedObjects`/`rejectedObjects` (`classify.ts:27-31`)** — two-line
  mirror-image functions. Deliberate, readable, and both are exported API. Fine.

### What was checked and found clean

- **No accumulator loops anywhere.** `advanceMark` uses `reduce`; `listKeysAfter` uses
  `flatMap`/`flatMap`/`toSorted`; `deliverAll` threads the promise chain through `reduce` exactly as
  `sequentialPromises_good` prescribes; `omitUndefined` uses `Object.fromEntries(Object.entries(…).filter(…))`
  exactly as `loopWithPredicate_good` prescribes. The two `.forEach` calls
  (`daemon.ts:52`, `index.ts:80`) are side-effect-only and close over no accumulator. This is the rule
  most commonly violated and it is clean.
- **No enums; no `function` keyword; no trailing semicolons; arrow functions throughout.**
- **`Record` lookups over if/else-if chains**: `shellCommands`, `notifierAdapters`, `eventTypeLabels`,
  `eventTypeSounds`, `stateOutcomeMessages` are all the prescribed shape, and `stateOutcomeMessages` is
  a full (not `Partial`) `Record` over the union so the compiler enforces exhaustiveness.
- **Result types**: every fallible function returns `Either` or a tagged union. No bare `null`/`undefined`
  returns.
- **300-line limit**: largest source file is `notify.ts` at 125 lines.
- **Gather/Compute/Persist and module SRP**: genuinely separated, and `classify.ts` — added beyond the
  plan — is the right call for exactly the reason the execution notes give.
- **Logging** conforms to `.agents/guidance/logging.md`: per-destination serialization (JSON to file,
  `printf` to console), `env`/`service`/`timestamp` defaultMeta, per-call splat appended to the console
  line, and every failure log names the offending value.
- **`testing/fake-s3.ts` earns its place** (the third flagged item). `.agents/tests.md` prefers real
  infrastructure, and the opt-in `poller.integration.spec.ts` is a proper real-bucket suite with
  key-tracked fixtures torn down by key and no bucket wipe — exactly what the guidance asks for. The
  fake is a *transport* substitution on a **real** `S3Client`, so `paginateListObjectsV2`,
  `GetObjectCommand`, and the pagination/`StartAfter` semantics are the production code path under
  test; and it covers cases (a failing `send`, a forced `pageSize: 1`) that are awkward to provoke
  against real S3. Making the real-bucket suite the default would make `pnpm test` require an AWS
  account, which would break the feature's own first acceptance criterion. Keep both; no change
  recommended.
- **Fence compliance**: no `terraform apply` was executed, no committed credentials or secrets, no
  `.claude/` or `AGENTS.md` in the diff, and `.gitignore` correctly ignores the AI-config trees while
  leaving `.agents/plans/` tracked.
- **AWE-151/AWE-152 `## Deferred verification` sections** are accurate. Nothing unverified is marked
  met; the `terraform plan` claim correctly discloses that it ran against a scratch copy with
  `backend.tf` removed; the closing commands are correct apart from nit #17; and the statement that
  **no NS records were written into the live `fifthdimensionengineering.com` zone** is consistent with
  everything else in the diff. The one summarising slip is nit #18.

### Suggested merge gate

Fix **#1** before merge — it is silent, permanent event loss in the contract, and it is free to fix
now and expensive after the first `apply`. **#2–#7** should land in the same fix round (**#3** and
**#6** also correct claims in the plan files, which are the merge's audit trail). **#8–#20** are
reasonable follow-ups; **#12**'s quarantine half and **#15** are natural candidates for a follow-up
story rather than this branch.

---

## R2 — 2026-07-19

**Reviewer:** independent R2 (fresh eyes; did not write the code and was not the R1 reviewer)
**Diff reviewed:** `git diff auto/execute-remaining-bootstrap-github..feat/bootstrap-and-iac` (96 files), with the four fix commits `e911e4f..HEAD` read individually
**Guidance loaded in full:** `.agents/general.md`, `formatting.md`, `tests.md`, `languages/typescript/{typescript,typescript-testing,object-types-typescript}.md`, `frameworks/node/preferences.md`, `frameworks/effect/effect.md`, `guidance/{aws,logging,adr,now}.md`, `code-examples/typescript/src/looping.ts`

### Verdict

**Findings — 0 blockers, 1 major, 7 minor, 4 nits.**

The fix round is genuinely good. Every R1 item marked fixed was checked against the source and, where
possible, probed at runtime against the built package — none of them is papered over, and none
introduced a functional regression. The blocker fix (#1) is correct as far as it goes and is now
guarded by specs that would catch a regression. The daemon rewrite (#2) neither leaks frames nor
truncates work, and shutdown genuinely completes the in-flight tick. The codec change (#5) is
byte-stable on adversarial input and no consumer still assumes a `URL` instance. The Terraform module
is behaviourally equivalent for both roots. The plan-file corrections are accurate.

The one major is not a fix that went wrong — it is the part of the blocker's own invariant the fix
round did not close and did not record, while the surrounding comment asserts the opposite.

### Independent verification performed

| Check | Result |
| :--- | :--- |
| `pnpm install` | clean, lockfile up to date |
| `pnpm build --force` | 2/2 tasks green (incl. the new `dist/testing/exemplars.{js,d.ts}` entry) |
| `pnpm lint --force` | 3/3 green — biome clean over 33 files, `terraform fmt -check -recursive .` clean |
| `pnpm test --force` | **173 passed, 5 skipped** (87 event-model + 86 desktop-notifier). The `feature.md` claim of 173 is **accurate**. |
| `pnpm typecheck --force` | 3/3 green |
| `terraform fmt -check -recursive infra` | clean |
| `pnpm --filter @personal-events/infra validate` | **Success** for both `bootstrap/` and `personal-events/` — the R1 #16 fix is real |
| `turbo run test --dry=json` inputs inspection | see finding R2-2 |
| Codec probed at runtime against `dist/index.js` | see fix audit and finding R2-1 |
| Diff scanned for `AKIA`/`ASIA`/`BEGIN … PRIVATE KEY`/`aws_secret_access_key`/`.claude/`/`AGENTS.md`/`*.tfstate` | **none present** |
| Diff scanned for applied side effects | **none** — every `terraform apply` occurrence is documentation or an npm script; no `.tfstate`, no `backend.hcl`, `.gitignore` covers both |

### Fix audit — did each R1 fix actually resolve the defect?

| R1 # | Verdict | Evidence |
| :--- | :--- | :--- |
| **#1** BLOCKER (timestamp width) | **Fixed, with a residual** | `isoInstantPattern` and the timestamp group of `eventKeyPattern` are both `\.\d{3}Z`. Because the instant is now fixed at 24 chars and position 24 is always `.`, any two keys with *distinct* instants resolve their comparison inside the timestamp — so lexicographic order **is** chronological order across the whole key for distinct instants. The `p(\d)` tightening (#10) also fixes the priority segment's width, so the tie-break segments are stable too. `advanceMark` is unchanged and remains correct (`reduce` to the lexicographic max, never moves backwards — pinned by `poller.spec.ts`). **Residual:** for *equal* instants the tie-break is `eventType` → `priority` → `source` → `name`, and the mark is a high-water mark over the whole key — see finding **R2-1**. |
| **#2** MAJOR (daemon loop) | **Fixed, correctly** | `runDaemon` now resolves one outer promise and schedules each tick from the previous tick's `.then`, discarding the tick promise (`void`). Nothing chains: the only retained state is `state`, `ticking`, and one timer handle, so frames unwind. Shutdown: `onAbort` stops immediately only when `!ticking`; an abort *during* a tick is a no-op and the tick's own continuation calls `stop()` after `deliverAll` and `advance` have completed. The spec `"stops after finishing the tick it is in when aborted mid-run"` aborts synchronously (the promise executor runs `tick()` before `runDaemon` returns) and asserts `mark === laterKey` with 2 notifications raised — so the reported first-attempt regression (truncated ticks, lost notifications) is genuinely gone, not just moved. The guard spec added for the *shape* is vacuous, though — finding **R2-4**. |
| **#3** MAJOR (`eventType` message) | **Fixed** | Probed against `dist/index.js`: `parseKey("…warning…")` now yields `└─ ["eventType"] └─ EventType ├─ Expected "alert", actual "warning"`. The `as EventType` cast is a real cast, but `EventTypeSchema` inside `EventKeyComponents` is the gate and the spec asserts the message contains `eventType`. The plan's execution note was corrected rather than quietly rewritten. |
| **#4** MAJOR (bucket pre-flight) | **Fixed, with a caveat** | `probeBucket` mirrors `probeCredentials` exactly and gates `start()` before any state is loaded or any handler installed, so it cannot wedge a running daemon. `HeadBucket` inherits the SDK's bounded retry/timeout policy, so it fails rather than hangs. `describeBucketFailure` correctly translates 404/403/301 and falls back to `describeCause` — five specs pin it. **Caveat:** the caller does not use the distinction it computes — finding **R2-3**. |
| **#5** MAJOR (`Schema.URL`) | **Fixed, genuinely byte-stable** | `WorkItemUrl` is `Schema.String` + `Schema.filter(URL.canParse)`, so encode is identity. `parse.spec.ts` round-trips three inputs a normalizing codec would move (`https://github.com`, `HTTPS://GitHub.com/Foo`, `https://x.test/a?b=1&b=2`) and a companion spec asserts `new URL(...)` *would* have rewritten them. Nothing downstream assumes a `URL` instance: `grep` finds no `.href` outside the spec that documents the hazard; `notification-content.ts` interpolates the string directly; `parse.spec.ts:25` asserts `event.workItem` `toBe` a string. README and the ADR-adjacent docs both say "stored verbatim". |
| **#6** MAJOR (log assertions) | **Fixed, well** | `testing/capture-logger.ts` uses a real winston `Stream` transport with `format.json()`, so assertions run against the same serialization the file transport emits, `defaultMeta` included — a stronger choice than R1's proposed hand-rolled `Transport` subclass. Five specs cover the skip warning (level, `key`, `reason` naming `priority`), a delivery line per event with its triage fields, `service`/`env` on every record, the undelivered-notification error line, and silence on an idle tick. |
| **#7** MAJOR (exemplar duplication) | **Fixed; export resolves** | The three byte-identical copies are gone; only `not-json.txt` remains local. `exports["./testing"]` → `dist/testing/exemplars.{d.ts,js}`, both emitted by the new second tsup entry (verified in the build log); `files: ["dist","exemplars"]` and `exports["./exemplars/*"]` are correct. `import.meta.dirname + "../../exemplars"` resolves identically from `src/testing/` and `dist/testing/`. The consumer's suite compiles, typechecks and passes against it. **But** the turbo cache no longer tracks the dependency — finding **R2-2**. |
| **#8** MINOR (Terraform dup) | **Fixed; equivalent for both roots** | Diffed the pre-refactor `state-bucket.tf` and `s3.tf` against the module + call sites. `personal-events`: identical resources, identical arguments, all three rule ids preserved (`tier-current-versions` 90d→STANDARD_IA / 365d→GLACIER_IR, `trim-superseded-versions` keep-5 / `var.noncurrent_version_retention_days`, `abort-incomplete-uploads` 7d). `bootstrap`: `transitions` defaults to `[]` and the `dynamic "rule"` emits nothing, so the tiering rule correctly does **not** appear; retention 90d / keep-20 preserved. Tags still flow from each root's `default_tags`. Only the bootstrap rule *id* changed — nit **R2-11**. |
| **#9** MINOR (`describeCause`) | **Fixed** | Exactly one definition remains repo-wide (`packages/event-model/src/describe-cause.ts`), exported from the package root and imported by all four app sites. |
| #10, #13, #14, #16, #17, #18, #19, #20 | **Fixed** | `p05` now rejected (probed); `env`/`logLevel` are `Schema.Literal` with specs rejecting `production`/`verbse`; `Delivery` narrows `deliverAll`/`deliverOne`; `validate` scripts `init -backend=false` first and cover both roots (run and confirmed); the two `-chdir` commands corrected; `feature.md`'s two overclaims corrected and the previous wording named rather than silently replaced; carve-outs recorded in `CLAUDE.md`; the dotted-bucket trade-off recorded in the ADR with a revision-log entry. |
| #11, #12, #15 | **Deliberately deferred, honestly** | All three are in `feature.md` § "Follow-up candidates" with accurate descriptions. #12 is correctly flagged as needing a product decision. I re-confirmed #11's premises at runtime: `2026-13-45T99:99:99.000Z` still parses `Right`, and `name` still accepts `a/b`, `a\nb`, `a b`, and astral-plane characters. |

**Nothing was found to be superficially patched but still broken.**

### Findings

#### R2-1. MAJOR — the high-water mark is over *producer-supplied* timestamps, so a later-written key that sorts lower is still lost forever; the module comment claims the opposite

`apps/desktop-notifier/src/poller.ts:3-8,20-28`

```
 * Gather: one poll of the bucket. Keys carry a leading ISO instant, so they sort chronologically
 * and `ListObjectsV2` `StartAfter` (exclusive) gives exactly the objects written since the last
 * one processed. Ordering is by key string, never `LastModified` — clock skew between producers
 * would reorder events under a timestamp comparison.
```

Both sentences are wrong in a way that matters, and the second is exactly backwards.

`StartAfter` does not give "the objects written since the last one processed" — it gives the objects
whose **key** sorts above the mark. The key's leading instant is the *producer's* clock, not S3's
write time, so any object written after the mark advanced but bearing a lower-sorting key is never
returned. Two concrete triggers:

1. **Same-instant tie-break.** Fixing the fraction at three digits made the ordering total, but it did
   not make it *write-order*. Within one millisecond the order is `eventType` → `priority` →
   `source` → `name`, and `alert` < `notification`, `p1` < `p8`. Verified against the built package:

   ```
   A = 2026-01-01T00:00:00.000Z.alert.p5.github.x.json
   B = 2026-01-01T00:00:00.000Z.notification.p8.github.x.json
   A < B  → true
   ```

   A producer that stamps a batch with one `toISOString()` and `PutObject`s them sequentially — the
   ordinary shape for the `claude-code-integration` and `github-integration` producers the plans
   anticipate — writes `B` then `A`. A poll landing between the two `PutObject`s sets the mark to `B`;
   `A` is then permanently invisible and `state.json` persists the skip across restarts. This is the
   *same failure mode and the same permanence* as R1 #1, reached by a different route.
2. **Producer clock skew.** With several producers on different machines (the plans have at least
   three), a producer whose clock is a second slow writes a key that sorts below a mark already set by
   a faster machine, and is skipped. The comment's rationale is inverted: `LastModified` is S3's
   *single server* clock and is the option that is *immune* to producer skew; ordering by key is
   precisely a producer-timestamp comparison and is the option that carries it.

`advanceMark`'s own spec (`poller.spec.ts:34-39`, "distinguishes two events written in the same
millisecond by their full key") shows the tie-break was thought about, but it asserts only that the
two keys are distinguishable, not that the losing one is ever delivered.

This is not in `feature.md` § "Follow-up candidates" (which covers #11, #12, #15, #20) and not in the
ADR's "One-way door" paragraph, which discusses renaming keys but not this.

**Proposed fix (minimum, this branch):** correct the comment — say that `StartAfter` returns objects
whose *key* sorts above the mark, that the key's instant is the producer's clock, and that an object
written with a key below the current mark is not re-listed. Add a row to "Follow-up candidates" naming
the two triggers. **Proposed fix (real, follow-up story):** poll with a lookback —
`StartAfter = max(mark − lookbackWindow, seed)` — and keep the set of keys already delivered inside the
window in `state.json`, so a late or skewed write inside the window is still delivered exactly once.
The window is the maximum producer skew you are willing to tolerate. This is the same product decision
as #12 and should probably be asked in the same breath.

#### R2-2. MINOR — the #7 dedup is not tracked by the turbo cache, so editing a canonical exemplar leaves the consumer's suite reporting a stale PASS

`turbo.json:8`

```json
"build": { "dependsOn": ["^build"], "inputs": ["src/**", "tsup.config.ts", "tsconfig.json", "package.json"], "outputs": ["dist/**"] }
```

An explicit `inputs` array **replaces** turbo's default (all git-tracked files in the package), so
`packages/event-model/exemplars/**` is not in the `build` hash. Confirmed empirically with
`turbo run test --dry=json`: `@personal-events/event-model#build`'s inputs are exactly

```
package.json, src/*.ts, src/testing/exemplars.ts, tsconfig.json, tsup.config.ts
```

— no `exemplars/`. `@personal-events/desktop-notifier#test` hashes its own `src/**` and `exemplars/**`
plus the dependency's `build` hash, so **changing `packages/event-model/exemplars/valid-github-pull-request.json`
invalidates neither**, and `pnpm test` replays a cached PASS for the app without running it.

That is precisely the silent-drift failure R1 #7 existed to prevent, reintroduced one layer down: the
app's suite now genuinely depends on a file it does not declare and its dependency does not export.
(`event-model`'s own `test` task does list `exemplars/**`, so only the consumer is affected — and only
on cached runs; the `--force` verification above is unaffected.)

**Proposed fix:** add `"exemplars/**"` to `build.inputs` (the exemplars are a published artefact of the
package — `files` and `exports` already say so), or use `["$TURBO_DEFAULT$"]`. Adding `"exemplars/**"`
to `build.outputs` as well would make the dependency explicit both ways.

#### R2-3. MINOR — `probeBucket`'s failure path treats a transport error identically to a typo'd bucket, so a laptop daemon started before the network is up exits instead of retrying

`apps/desktop-notifier/src/index.ts:39-47`; `apps/desktop-notifier/src/s3-client.ts:46-66`

`describeBucketFailure` carefully distinguishes 404 ("no such bucket"), 403 ("access denied"), 301
("wrong region") and *everything else* (network, DNS, TLS, `getaddrinfo ENOTFOUND` — which has its own
spec at `s3-client.spec.ts:42`). `start()` then discards the distinction and returns exit code 1 for all
of them.

The pre-flight is required by `.agents/guidance/aws.md` and the fix is right in substance, but the
guidance's stated purpose is *"to ensure the bucket exists"* — a DNS failure is not evidence that it
does not. This daemon's documented home is a laptop (`config.ts:15-23` reasons from exactly that), and
a login-time start racing wifi association is the ordinary case, not the exotic one. Today that is a
process that exits 1 and stays dead until the user notices; before this change it started and backed
off, which for *this* failure was the better behaviour.

**Proposed fix:** widen `BucketProbeResult` to a third `_tag` (`BucketProbeInconclusive`) returned when
`httpStatusOf(cause)` is `undefined` or ≥ 500, and let `start()` log it at `warn` and continue into the
normal back-off loop; keep the hard exit for 404/403/301, which are the misconfigurations the guidance
is actually about. One extra tag and one extra branch, and it keeps the typo'd-`EVENT_BUCKET` behaviour
the fix was for.

#### R2-4. MINOR (test-coverage) — the spec that claims to guard R1 #2's scheduling shape passes just as happily under the buggy implementation

`apps/desktop-notifier/src/daemon.spec.ts:215-245`

```ts
/**
 * Guards the scheduling shape rather than the output: a daemon that chains each tick's promise to
 * the next retains one pending promise and one async frame per tick for the life of the process.
 * …
 */
it("settles each tick independently instead of chaining them into one unbounded promise", …)
```

The only assertion is `polls > 3` after 50 ms at a 1 ms interval. The pre-fix implementation
(`await runTick` → `await delay` → `return runDaemon(...)`) also performs well over three polls in
50 ms — it leaked frames, it did not run slowly. So the spec does not discriminate between the two
implementations and would not have caught the defect it is documented as guarding. The inline comment
("Many ticks completed while the outer promise was still pending, so no tick was waiting on a later
one to settle") does not follow from what is measured: under the old code the outer promise was also
pending while many ticks completed.

`.agents/languages/typescript/typescript-testing.md`: *"Tests must validate actual business logic,
avoid writing tests that only effectively test the mocking framework."* The same spirit applies — a
regression guard that cannot fail on the regression is worse than none, because it stops anyone
looking again.

**Proposed fix:** either make it discriminating — the honest observable is stack depth, e.g. run with a
tiny interval and assert that a `runTick` invocation's `new Error().stack` does not grow with the tick
count — or drop the docblock's claim, rename it to what it does test ("keeps polling on a schedule"),
and record in `CLAUDE.md` § "Rules biome cannot enforce" that the non-chaining shape is a review
responsibility. What should not stand is a spec whose name and comment assert a guarantee it does not
provide.

#### R2-5. MINOR — the new module boundary has no variable validation, and the two roots disagree about whether `env` is validated at all

`infra/modules/hardened-bucket/variables.tf`; `infra/bootstrap/variables.tf:7-11` vs `infra/personal-events/variables.tf:7-16`

The fix round created a module boundary, which is the point at which inputs become a contract. None of
the five inputs carries a `validation` block: `noncurrent_version_retention_days = 0`,
`newer_noncurrent_versions_kept = -1`, or `storage_class = "GLACIAR"` all pass `terraform validate` and
fail only at `apply`, against real AWS, after the bucket has been created. `bucket_name` is likewise
unconstrained even though S3 bucket names have a well-known grammar.

Separately, `personal-events` validates `env ∈ ["prod","dev","staging","qa","local"]` while `bootstrap`
— which uses `env` to name the state bucket in exactly the same scheme — validates nothing, so
`-var env=Prod` silently produces `tfstate.Prod.…` and fails at apply on the uppercase letter.

**Proposed fix:** add `validation` blocks to the module (`days > 0`, `storage_class` in the S3 set,
retention/kept `>= 0`) and lift `personal-events`' `env` validation into `bootstrap` verbatim — or into
a shared `locals`/variable definition if you prefer one place.

#### R2-6. MINOR — the environment vocabulary forks between the Terraform half and the TypeScript half, and the documented carve-out only half-covers it

`infra/personal-events/variables.tf:13` vs `apps/desktop-notifier/src/config.ts:24`; `CLAUDE.md:60-63`

- Terraform accepts `["prod","dev","staging","qa","local"]` — `.agents/guidance/aws.md`'s spelling.
- The daemon accepts `["local","dev","qa","stage","prod"]` — `.agents/guidance/logging.md`'s spelling,
  plus `local`.

So `staging` is a legal Terraform `env` (it names buckets `events.staging.…`) and an **illegal** daemon
`ENV`, and `stage` is the reverse. The `CLAUDE.md` carve-out justifies adding `local` by citing
`aws.md`'s environment list — but the same list contains `staging`, which was not added, so the
carve-out's own reasoning is applied to one value and not the other.

The deviation itself is **justified and properly recorded** (see the assessment below); it is the
*scope* that is inconsistent.

**Proposed fix:** pick one spelling for the project and state it once — either add `staging` to
`deploymentEnvs` and say the project uses `aws.md`'s list, or change the Terraform validation to
`stage` and say the project uses `logging.md`'s list plus `local`. Then reference that single sentence
from both the `CLAUDE.md` carve-out and `variables.tf`.

#### R2-7. MINOR — an unusable state file is logged at `info`, the same level as a clean resume

`apps/desktop-notifier/src/index.ts:74-78,84-88`

```ts
logger.info(stateOutcomeMessages[loaded._tag], { stateFile: config.stateFile, …reason })
```

`LoadedState`, `NoState` and `LoadStateFailure` all log at `info`. But `LoadStateFailure` means the
stored high-water mark was discarded and the daemon is restarting from "now" — every event written to
the bucket between the last successful save and this start is silently never notified.
`.agents/guidance/logging.md`: *"`warn` is used when the state being logged may be a problem."* This is
that. The `reason` and `stateFile` are correctly included, so only the level is wrong — but the level
is what an operator filters on.

**Proposed fix:** split the level out of the same `Record` lookup the message uses, e.g.
`const stateOutcomeLevels: Record<LoadStateResult["_tag"], "info" | "warn"> = { LoadedState: "info",
NoState: "info", LoadStateFailure: "warn" }` and `logger.log(stateOutcomeLevels[loaded._tag], …)` —
which keeps the full-`Record` exhaustiveness the file already uses.

#### R2-8. MINOR (guidance) — there is no `NOW.md`, which `.agents/general.md`'s trigger table mandates and `.agents/tests.md` depends on

`.agents/general.md` § Context Specific Guidance:

> | Development logging | `.agents/guidance/now.md` | At the start of every work session and when completing significant actions |

`.agents/guidance/now.md`:

> *"A log of all AI actions must be kept in the file NOW.md located in the project root. If the file
> does not exist, create one. This file is strictly append-only."*

`find . -iname "NOW.md"` returns nothing. Four stories and a fix round were executed with no session
log. R1 did not check this either — I re-walked the trigger table independently, and this is the one
row neither pass covered. (Every other triggered row *is* honoured: TypeScript, Node, Effect — with the
missing `.agents/cache/effect/**` honestly disclosed and `/update-effect-docs` recommended — AWS,
Logging, ADR with all three files and a revision-log entry, and Planning artifacts.)

It is not purely bookkeeping: `.agents/tests.md` § Test Removal Protocol makes `NOW.md` the mechanism —
*"No test may be deleted or skipped unless: a rationale is included in NOW.md with `@test-removed`"* —
and this round did remove a spec (`"recovers a millisecond-less timestamp"`). The removal is well
justified and is documented in `event-model-package.md`, so the substance is fine; the required
artefact is simply absent.

**Proposed fix:** create `NOW.md` at the repo root with a back-dated entry for this feature's execution
and one for the R1 fix round including a `@test-removed` line for the millisecond-less spec, and keep
appending. If the project genuinely intends not to keep one, that belongs in `CLAUDE.md` §
"Documented carve-outs" alongside the other two.

#### R2-9. NIT — the fix round introduced a fall-through `if` that the carve-out it also introduced does not cover

`apps/desktop-notifier/src/daemon.ts:67-71`

```ts
const onAbort = (): void => {
  if (!ticking) {
    stop()
  }
}
```

`CLAUDE.md` § "Documented carve-outs" (added in commit `627566d`, i.e. this same round) scopes the
exemption precisely: *"This exemption covers guards that return or throw immediately, nothing more."*
`onAbort` neither returns nor throws — it is a conditional side effect with no `else`, so it falls
under the unmodified rule in `.agents/languages/typescript/typescript.md` (*"Avoid fall-through if
statements, always use if AND else"*). Every other `if` in the diff genuinely is a returning guard.

Recording it because R1 #19's stated worry was *"the rule quietly eroding across future files"*, and the
first new file after the carve-out was written is where it eroded.

**Proposed fix:** `if (!ticking) { stop() } else { /* the tick's continuation stops after it finishes */ }`,
or hoist the condition into a named predicate and keep the two-branch form. Either is a one-line change.

#### R2-10. NIT — `desktop-notifier-daemon.md`'s spec count is wrong

`.agents/plans/bootstrap-and-iac/desktop-notifier-daemon.md` § "R1 review fixes": *"Spec count rose
60 → 87."* Measured: the desktop-notifier package runs **86 passed, 5 skipped (91 total)**; `87` is the
event-model figure, correctly stated in `event-model-package.md`. The starting `60` is right.

Trivial in itself, but these plan files are the merge's audit trail and R1 already had to correct four
claims in them — worth one more pass with the numbers in front of you.

**Proposed fix:** *"Spec count rose 60 → 86 passing (91 including the five opt-in specs)."*

#### R2-11. NIT — the bootstrap lifecycle rule was silently renamed, and the equivalence note only covers the other root

`infra/bootstrap/state-bucket.tf` (was `trim-superseded-state-versions`, now `trim-superseded-versions`
from the shared module); `infra-s3-and-dns.md` § R1 fixes.

The re-plan note asserts *"all three lifecycle rules intact (`tier-current-versions` … ,
`trim-superseded-versions` … , `abort-incomplete-uploads` …)"* — but those are the `personal-events`
rules. The bootstrap root's rule id changed. With no state anywhere this is free (the rule id is a
child of `aws_s3_bucket_lifecycle_configuration`, so it is a rewrite of the same resource, not a
destroy), and the retention values are preserved exactly — but the note's own "if this branch is ever
rebased onto an applied state" caveat lists `state mv` and not this.

**Proposed fix:** one clause in the same bullet: *"the bootstrap rule id also changed from
`trim-superseded-state-versions` to the module's `trim-superseded-versions`; same values, and on an
applied state it is an in-place update of the lifecycle configuration."*

#### R2-12. NIT — root `pnpm lint` requires `terraform` on `PATH`

`infra/package.json:8`; `CLAUDE.md:20`

`CLAUDE.md` advertises `pnpm lint` as a root command, and `turbo run lint` includes the `infra` member,
whose `lint` is `terraform fmt -check -recursive .`. A contributor (or CI job) without the Terraform
CLI cannot run the repo's lint at all — the failure is a missing binary, not a lint error.

**Proposed fix:** either note the prerequisite in `CLAUDE.md`/`README.md` next to the root commands, or
make the infra lint script degrade (`command -v terraform >/dev/null || { echo "terraform not
installed; skipping fmt check"; exit 0; }`). The first is probably right for a project whose whole
substrate is Terraform — just say so.

### DRY vs WET assessment (current state, including duplication the fix round introduced)

**The fix round measurably reduced real duplication, and did not trade it for hidden coupling in the
code.** All three of R1's duplication findings are genuinely resolved:

| R1 # | Before | After |
| :--- | :--- | :--- |
| #7 | 3 byte-identical exemplar JSONs + 2 near-identical loaders across two members | 0 duplicated exemplars; one `exemplarReader(dir)` + `readExemplar*` in the package, and a 3-line re-export in the app. The app keeps only `not-json.txt`, which is correctly its own concern. |
| #8 | 6 hardened-bucket resources restated in two roots | One `infra/modules/hardened-bucket/`; both roots call it; only retention/tiering differ and both are inputs. Verified equivalent for both roots. |
| #9 | `describeCause` × 5 | Exactly one definition repo-wide. |

**Duplication the fix round itself introduced — two instances, both worth naming:**

1. **The `.`/`Z` ordering rationale is now stated at length in six places** — `event.ts:23-35`,
   `event-key.ts:20-29`, `packages/event-model/README.md:36-41`, `event.spec.ts:41-46`,
   `event-model-package.md`, and `feature.md`'s R1 section (plus the commit message). Each copy carries
   the same worked example (`…02Z…` > `…02.500Z…`). This is documentation, not logic, and the
   redundancy is defensible for a contract this load-bearing — but it is now the *most* duplicated
   thing in the diff, and finding **R2-1** shows exactly the cost: the explanation is subtly incomplete
   in all six places at once, and correcting it is a six-file edit. **Recommendation:** keep the
   `event.ts` docblock as the single normative statement and have the other five point at it
   (*"see `event.ts` → `isoInstantPattern`"*) rather than restating the argument.
2. **`daemon.spec.ts` hand-rolls `DaemonDependencies` twice** despite `dependenciesFor` existing —
   lines 102-108 (pre-existing) and 227-233 (**added by this round's new spec**). Six lines, twice, one
   of which the helper could produce with an extra optional parameter. Small, but it is the kind of
   accretion that makes a fixture helper stop being used at all. **Recommendation:** give
   `dependenciesFor` an options object and route both through it.
3. **`versions.tf` is now duplicated three ways, not two.** R1 flagged `bootstrap/versions.tf` ≡
   `personal-events/versions.tf`; the new `modules/hardened-bucket/versions.tf` is a byte-identical
   third copy. This is **correct and unavoidable** — a Terraform module must declare its own
   `required_providers` — so it is acceptable WET, but it is worth stating plainly that the module
   extraction did not reduce that particular duplication, it increased it.

**Near-misses re-examined and confirmed acceptable WET** (I agree with R1 and re-checked each):
per-member `tsconfig.json`/`vitest.config.ts`/`tsup.config.ts` (each three-to-seven lines, must exist
per member, and they now differ *more* than before — event-model has two entries and `dts: true`, the
app has one and a shebang banner); the tagged-union result shapes (`NotifyResult`, `LoadStateResult`,
`CredentialProbeResult`, `BucketProbeResult`, `ClassifiedObject`) — a repeated *shape* with different
members and different axes of change, and `BucketProbeResult` deliberately mirroring
`CredentialProbeResult` is the fix's best feature, not its worst; the two roots' `providers.tf` and
`locals.tf` (five lines each, genuinely different tag sets, and a root module is the right owner of its
own provider); `parsedObjects`/`rejectedObjects`.

**One genuine remaining duplication, unchanged since R1 and not flagged by it:** the root
`vitest.config.ts` declares `test.projects: ["packages/*", "apps/*"]` **and** every member declares its
own `vitest.config.ts` with a `test` script that turbo runs directly. So there are two independent ways
to run the suite with different settings — the root path applies `disableConsoleIntercept` and coverage,
the turbo path does not. `pnpm test` uses the turbo path, so the root config's coverage settings never
take effect. Not a defect today; worth deciding which one is canonical before someone adds a coverage
gate to the one that is not running.

### Honesty audit

**Fence compliance: clean.** The diff creates no AWS resources and records none. No `*.tfstate`, no
`backend.hcl`, no `.terraform/` (all gitignored, and the `.gitignore` comment correctly explains that
`.terraform.lock.hcl` *is* committed). Every `terraform apply` string in the diff is documentation, a
runbook step, or the `deploy` npm script. No credentials, keys, `AKIA`/`ASIA` prefixes, `.env`,
`.claude/`, or `AGENTS.md`. `.gitignore` correctly ignores the AI-config symlink trees while leaving
`.agents/plans/` tracked, per the user's staging rules. The statement that **no NS records were written
into the live `fifthdimensionengineering.com` zone** is consistent with everything in the diff.

**Plan-file accuracy: the R1 corrections are themselves correct, and I found one residual overclaim
(nit R2-10) and one omission (R2-1).**

| Claim | Verdict |
| :--- | :--- |
| `feature.md`: "173 specs green, verified uncached with `--force`" | **Accurate** — I measured exactly 173 passed / 5 skipped with `--force` on all four tasks. |
| `feature.md`: "the round trip is now pinned as *injective*" | **Accurate** — `event-key.spec.ts:91-98` asserts re-encode identity over three keys, and `p05` is a `Left`. |
| `feature.md`: "a malformed object is logged and skipped — **Met**, … the log line itself is now asserted" | **Accurate**, and the previous overclaim is named rather than quietly replaced. Good practice. |
| `feature.md`: "credentials and bucket failures exercised against the built daemon; the unparseable-object path … in the unit suite" | **Accurate** and correctly narrower than the R1-flagged wording. |
| `feature.md` / `infra-s3-and-dns.md`: "`Plan: 8 to add, 0 to change, 0 to destroy` … re-confirmed after the shared-module refactor" | **Consistent** — I count exactly 8 planned resources (6 bucket + child zone + parent NS record) both before and after; the module refactor changes addresses, not counts. Not independently re-run (it needs the account). |
| `infra-s3-and-dns.md` § Deferred verification, all 8 rows | **Accurate**; the `-chdir` corrections are right and the commands are now copy-pasteable. I ran the two offline ones (`fmt -check`, `validate` for both roots) and both behave as described. |
| `desktop-notifier-daemon.md` § Deferred verification, all 3 rows | **Accurate**; the "What WAS verified locally" section correctly separates what ran against the built daemon from what ran in the unit suite. |
| `desktop-notifier-daemon.md`: "Spec count rose 60 → 87" | **Wrong** — 86 passing / 91 total. Nit **R2-10**. |
| `event-model-package.md`: "Spec count rose 59 → 87" | **Accurate.** |
| ADR revision log + state-changes | **Accurate and complete** — both the module extraction and the dotted-bucket trade-off are logged with reasons, and the body carries the trade-off section. Matches `.agents/guidance/adr.md`'s three-file structure. |
| Anything in the diff overclaiming a live AWS verification | **None found.** |

**Not recorded anywhere, and should be:** the same-instant / clock-skew loss path (finding **R2-1**).
The audit trail is otherwise unusually honest, which is exactly why this gap stands out — a reader of
`poller.ts` today would come away believing the opposite of the truth.

**Assessment of the two documented deviations:**

1. **`rewriteRelativeImportExtensions` instead of `allowImportingTsExtensions` — justified, and
   properly recorded.** The guidance's actual requirement is the *source convention* (`from
   "./foo.ts"`), and it names `allowImportingTsExtensions` as the mechanism. That flag requires
   `noEmit`/`emitDeclarationOnly`, which is fine for the per-package `tsc --noEmit` typecheck but would
   be a problem the moment `tsc` is asked to emit; `rewriteRelativeImportExtensions` achieves the same
   source convention and rewrites to `.js` on emit, so it is strictly more capable. I verified the
   convention actually holds (every relative import in both members carries `.ts`) and that
   `pnpm typecheck` is green under `moduleResolution: NodeNext`. The `CLAUDE.md` entry states the
   substitution, the reason, and that it is deliberate. **Correct call, correctly recorded.**
2. **Accepting `local` as a fifth `env` — justified in substance, incompletely scoped.** The guidance
   conflict is real: `logging.md` fixes the set at four, `aws.md` names five environments for this kind
   of project including `local`, and a laptop-resident daemon that refuses its own default environment
   is unusable. Crucially it is an *explicit literal*, not a silent fallback — `config.spec.ts:40-47`
   proves `production` is still rejected — which addresses the specific harm `logging.md`'s closed set
   exists to prevent (a wrongly-stamped shipped record). It is recorded in `CLAUDE.md` and in the
   story's R1-fixes section. **The deviation is justified**; the scope is not internally consistent,
   because the same `aws.md` list also contains `staging` and the Terraform side already accepts it —
   finding **R2-6**.

### What was checked and found clean

- **No accumulator loops.** Re-walked every iteration site against `looping.ts` in full. `advanceMark`
  is `reduce`; `listKeysAfter` is `flatMap`/`flatMap`/`toSorted`; `deliverAll` threads the promise
  chain through `reduce` exactly as `sequentialPromises_good` prescribes; `omitUndefined` is
  `Object.fromEntries(Object.entries(…).filter(…))` exactly as `loopWithPredicate_good` prescribes;
  `parseRecords` (new this round) is `split`/`filter`/`map`. The three `let`s introduced in `runDaemon`
  (`state`, `ticking`, `timer`) are **not** a violation — the rule bans a loop filling a previously
  declared accumulator, and this is an event-driven state machine with no loop at all; the same is true
  of `fallbackNotifier`'s `primaryUsable` latch and `capture-logger`'s captured array.
- **`Record` lookups over `if`/`else if` chains** — `bucketFailuresByStatus` (new this round) is a
  correctly-`Partial` `Record` over an open key set with a `??` fallback, which is exactly the case
  `typescript.md` permits; `stateOutcomeMessages` remains a full `Record` over the union.
- **Result types** — `BucketProbeResult` follows the established tagged-union shape; no new bare
  `null`/`undefined` return anywhere.
- **No enums, no `function` keyword, no trailing semicolons, arrows throughout**, explicit return types
  on every function including the new ones. Largest source file is `notify.ts` at 125 lines.
- **Gather/Compute/Persist** is unchanged and still visible at module level; `probeBucket` is correctly
  placed in `s3-client.ts` (the Gather-setup module) rather than accreting into `index.ts`, which is
  the `.agents/general.md` § "Beware fix-in-place drift" instinct applied correctly.
- **Slice-don't-dump** — `Delivery` is a real narrowing, and `deliverAll`/`deliverOne` now cannot reach
  `s3`/`bucket`/`stateFile` even by a later edit.
- **Logging** still conforms: per-destination serialization, `env`/`service`/`timestamp` in
  `defaultMeta`, splat appended to the console line only, and every failure log names the offending
  value. The new `capture-logger` asserts the `defaultMeta` requirement directly.
- **Terraform** — `fmt -check -recursive` and `validate` both clean for all three modules from a state
  where `.terraform/` exists; the `validate` scripts genuinely `init -backend=false` first (I ran them).
  Provider inheritance into the child module is correct (no `providers` block needed, `default_tags`
  flows from each root).
- **Signal handling** — `process.once` per signal is right: after the first `SIGINT` fires the listener
  is removed and Node restores default termination, so a second Ctrl-C force-quits rather than hanging.
  `stop()` clears the pending timer, so the event loop drains and the process exits with the code
  `main()` set.
- **State file** — temp-then-rename within the same directory is correct, and the spec asserts no temp
  file survives. Two daemons sharing one `STATE_FILE` would race last-writer-wins (re-notification, not
  loss) and a crash between `writeFile` and `rename` leaves an orphan `.<ts>.<pid>.tmp`; both are
  acceptable for a single-user desktop daemon and neither is worth a finding.
- **S3 pagination error handling** — a mid-pagination failure rejects the whole `pollOnce`, `runTick`
  catches it, and the mark is held, so a partial listing can never advance the mark. Correct. (The
  unbounded fan-out is R1 #15, deferred and recorded.)

### Suggested merge gate

**Nothing blocks the merge.** Fix **R2-1**'s comment and add its follow-up row before merging — that is
a five-minute documentation change and it is the difference between a known trade-off and a booby trap
for whoever reads `poller.ts` next; the lookback-window implementation itself belongs in the same
product conversation as #12. **R2-2** is worth folding in now because it is a one-line `turbo.json`
edit that protects the fix immediately above it. **R2-3 to R2-8** are good next-round work; **R2-9 to
R2-12** are housekeeping.

---

## R3 — 2026-07-19 (final gate)

**Reviewer:** independent R3 (fresh eyes; did not write the code, was not R1 and was not R2)
**Diff reviewed:** `git diff auto/execute-remaining-bootstrap-github..feat/bootstrap-and-iac` (100 files,
12 commits), with the three R2-fix commits `8beefd1..c341c82` read individually
**Guidance loaded in full:** `.agents/general.md`, `formatting.md`, `tests.md`,
`languages/typescript/{typescript,typescript-testing,object-types-typescript}.md`,
`frameworks/node/preferences.md`, `frameworks/effect/effect.md`, `guidance/{aws,logging,adr,now,planning-artifacts}.md`,
`code-examples/typescript/src/looping.ts`

### Verdict

**Findings — 0 blockers, 0 majors, 4 minors, 3 nits. Recommendation: merge after the four minors.**

Both fix rounds landed cleanly and nothing regressed. The third `BucketProbeInconclusive` outcome, the
`LoadStateFailure` level split, the Terraform module validation, the `exemplars/**` turbo input and the
environment-vocabulary unification were each read against their commit and re-derived from the source;
all five do what they claim. The branch is green uncached, the fence is intact, and the audit trail is
still unusually honest.

Everything below is cheap. The two that matter are a **false green in `pnpm lint`** (the same
explicit-`inputs` trap R2-2 found, surviving one member over) and a **measurably wrong technical claim
in `CLAUDE.md`** that argues against the very rule it accompanies.

### Independent verification performed

| Check | Result |
| :--- | :--- |
| `pnpm install --frozen-lockfile` | clean, lockfile up to date |
| `pnpm build --force` | 2/2 green |
| `pnpm lint --force` | 3/3 green |
| `pnpm typecheck --force` | 3/3 green |
| `pnpm test --force` | **182 passed, 5 skipped** — 87 event-model (3 files) + 95 desktop-notifier (8 files, 2 skipped). The agent's claim of 182/5 is **accurate**; `feature.md`'s "173" is now stale (finding **R3-5**). |
| `terraform fmt -check -recursive infra` | clean |
| `pnpm --filter @personal-events/infra validate` | **Success** for both `bootstrap/` and `personal-events/` |
| `turbo run lint --dry=json` inputs inspection | see finding **R3-1** |
| Recursive-await vs scheduled loop measured under `--expose-gc` | see the R2-4 adjudication and finding **R3-3** |
| Module contract probed offline with an out-of-range input | see finding **R3-7** |
| Diff scanned for `AKIA`/`ASIA`/`BEGIN … PRIVATE KEY`/`aws_secret_access_key`/`.claude/`/`AGENTS.md`/`*.tfstate`/`backend.hcl`/`.env` | **none present** |
| `git status --porcelain`, remote branches containing the tip | **clean tree, no upstream, no remote contains it** — nothing pushed |

### Fix audit — did the R2 round break anything?

| R2 # | Verdict | Evidence |
| :--- | :--- | :--- |
| **R2-1** doc + follow-up | **Correct, and better than proposed** | `poller.ts`'s docblock now says `StartAfter` is key-lexicographic, that the instant is the *producer's* clock, and that an object written below the mark is never re-listed; both triggers are named. It also goes beyond R2 by giving the honest reason `LastModified` is not simply the better option (not stable under re-writes, not expressible as `StartAfter`). `poller.spec.ts:48-68` is a genuine characterization suite pinning both routes and labelled as such. `packages/event-model/README.md` carries a **"Key order is not write order"** paragraph — the right place, and the one a downstream producer will actually read. Residual: the follow-up row's likelihood framing (**R3-4**). |
| **R2-2** turbo cache | **Fixed, for `build` and `test`** | `exemplars/**` is in both, with an explanatory comment stating the replace-not-merge semantics. The same trap survives in `lint` — **R3-1**. |
| **R2-3** inconclusive probe | **Fixed, correctly** | `toProbeFailure` returns `BucketUnreachable` only for a status that is `< 500` **and** present in `bucketFailuresByStatus` (404/403/301) — i.e. exactly the three misconfigurations the guidance is about — and `BucketProbeInconclusive` for everything else including `undefined` status. `start()` hard-exits on the first and logs `warn` + continues on the second. Seven specs pin it (three statuses definitive, three transport shapes inconclusive, one message-carrying). The typo'd-`EVENT_BUCKET` behaviour the R1 #4 fix existed for is preserved. |
| **R2-4** guard spec | **Disputed by the agent — dispute upheld, with one correction.** See below. |
| **R2-5** module validation | **Fixed** | Five inputs, seven `validation` blocks including an S3 bucket-name grammar and an IP-address exclusion; `bootstrap` gained the `env` validation it lacked. One value slips through — **R3-7**. |
| **R2-6** env vocabulary | **Fixed; complete in code, one dangling doc value** | `deploymentEnvs` and `ConfigSchema` use `staging`; both `variables.tf` validate `["local","dev","qa","staging","prod"]`; `CLAUDE.md` states it once and both halves point back at it; `config.spec.ts:44-49` asserts `stage` is now a `Left` and `staging` a `Right`. Grepped every `.ts`/`.tf`/`.md`/`.json` for word-boundary `stage`: the only live one left is `apps/desktop-notifier/README.md:48` — **R3-2**. |
| **R2-7** state-failure level | **Fixed, exactly as proposed** | `stateOutcomeLevels` is a full (not `Partial`) `Record` over `LoadStateResult["_tag"]`, so a new outcome must choose a level; `logger.log(level, message, meta)` keeps the existing `Record`-lookup shape. |
| **R2-8** `NOW.md` | **Fixed, and honestly** | Exists, append-only, newest last. The three back-dated entries are explicitly marked *(reconstructed)* with a preamble saying why, and the `@test-removed` rationale for *"recovers a millisecond-less timestamp"* is present with its reason. This is the right way to close a missing-artefact finding. |
| **R2-9** fall-through `if` | **Fixed at the site named; one new instance introduced in the same commit** | `daemon.ts:67-73` now has the two-branch form. `index.ts:50-56`, added by the same commit, is a new one — **R3-6**. |
| **R2-10, R2-11, R2-12** | **Fixed** | The bootstrap rule-id rename and its in-place-update consequence are now stated in the same bullet; the Terraform-CLI prerequisite is stated next to the root commands in `CLAUDE.md`. R2-10's number was corrected and has since gone stale again — **R3-5**. |

**Nothing the R2 round changed is superficially patched but still broken, and no R1 fix was undone.**

---

### Adjudication of the disputed R2-4 — the agent is right on three of four points

The agent disputed R2-4's proposed stack-depth discriminator, reported measuring async stack depth
5 vs 3 and heap 3 MB vs 4 MB, concluded neither discriminates, took R2's alternative (rename the spec,
move the shape to a documented review responsibility), and noted this weakens R1 #2's *"N async frames
retained"* framing.

I built both loop shapes side by side and measured retained heap at depth under `--expose-gc`, with a
control proving the instrument can see a deliberately-retained payload. Results (Node 24.14.0, arm64):

| Shape | 25 000 ticks | 100 000 ticks | 400 000 ticks | Bytes/tick |
| :--- | ---: | ---: | ---: | ---: |
| Chained (`return runDaemon(...)` from `async`) | +2 390 KB | +9 421 KB | +37 546 KB | **~97** |
| Scheduled (this branch) | — | +50 KB | — | **~1 (noise)** |
| Chained, per-tick state fattened by ~800 B on-heap | — | +9 422 KB | — | **~97 (unchanged)** |
| **Control** — same loop, states deliberately pushed to a live array | — | +106 415 KB | — | **1 090** |

Adjudication, point by point:

1. **"Async stack depth is not a discriminator" — CORRECT.** V8's zero-cost async stack traces do not
   chain across the recursive `await`, so the depth is a constant, not a function of tick count. R2's
   proposed assertion would not have worked.
2. **"The recursive call is in tail position, so V8 collects the closed-over state" — CORRECT, and this
   is the load-bearing half.** Fattening each tick's `next` by ~800 bytes of on-heap data moved the
   chained leak by **zero** (97 → 97 B/tick), while the control — the same loop retaining the same
   states in a live array — moved it to 1 090 B/tick. The async frame and its captures (`dependencies`,
   `schedule`, `next`, `signal`) are genuinely released when the function returns. **R1 #2's framing
   — "one async frame per tick, each closing over the whole dependency set" — is overstated, and the
   agent was right to say so.**
3. **"Heap retention does not diverge either" — INCORRECT as stated.** It diverges linearly and without
   bound at ~97 bytes/tick — the chain of pending `JSPromise` objects, their reaction records and their
   resolving-function closures, which the agent itself correctly identifies one sentence later as *"the
   residual cost of the bug"*. The 3 MB vs 4 MB observation simply lacked the tick count to resolve it:
   at 100 ticks the delta is ~10 KB, invisible in noise. **So the bug R1 #2 named is real and the fix
   is right — it is just ~30× cheaper per tick than R1 framed it, and not free as the current wording
   implies.** At the default 30 s interval the pre-fix cost was ~280 KB/day, ~8 MB/month, unbounded.
4. **"No cheap deterministic assertion" — a defensible engineering judgment, not a fact.** Heap growth
   *is* a discriminator at scale (9.4 MB vs 50 KB over 100 k ticks is a 190× separation), but it needs
   `--expose-gc`, which the vitest setup does not pass, and heap assertions are the classic flaky spec.
   Renaming the spec to what it tests and recording the shape in `CLAUDE.md` is the right call.

**Conclusion: the dispute is upheld and the disposition is correct.** The only defect is that the
*reason* recorded in three places is wrong in one direction while `daemon.ts`'s own docblock is still
wrong in the other — finding **R3-3**.

---

### Findings

#### R3-1. MINOR — `turbo.json`'s `lint.inputs` contains no Terraform file, so `pnpm lint` replays a cached PASS over unformatted HCL

`turbo.json:24`

```json
"lint": { "dependsOn": [], "inputs": ["src/**", "biome.json"], "outputs": [] }
```

`infra/` has no `src/`, and `biome.json` is package-relative so it matches nothing there. Confirmed with
`turbo run lint --dry=json` — `@personal-events/infra#lint`'s resolved input set is **`package.json`,
and nothing else**. Not one of the 20 `.tf` files in the repo is in the hash of the task whose entire
job is `terraform fmt -check -recursive .`.

Reproduced end to end (damage introduced, then restored; `git status` clean afterwards):

```
$ pnpm lint                                   # populate the cache
$ printf '\nlocals {\n      bad_indent = 1\n}\n' >> infra/bootstrap/locals.tf
$ terraform fmt -check -recursive infra       # → FAILS, as it should
$ pnpm lint
  Tasks:    3 successful, 3 total
  Cached:    3 cached, 3 total
    Time:    4ms >>> FULL TURBO             # ← green, on a tree fmt rejects
```

This is exactly **R2-2's defect class** — an explicit `inputs` array replaces turbo's default of all
git-tracked package files, so anything omitted stops invalidating — surviving in the one task R2 did not
inspect. The fix round added `exemplars/**` to `build` and `test` and wrote a comment above them
explaining precisely this hazard, then left `lint` alone.

Blast radius today is formatting only, which is why this is a minor and not a major; the reason to close
it now is the same reason R2-2 was closed now — the trap grows teeth the moment that script grows a
`terraform validate` or a `tflint`, and a gate that lies is worse than no gate.

**Proposed fix:** `"inputs": ["src/**", "**/*.tf", "biome.json"]`, or `"inputs": ["$TURBO_DEFAULT$"]`
if you would rather not enumerate. While there, note that the `"biome.json"` entry is dead — the root
`biome.json` is already covered by `globalDependencies` — so it can go or be left as documentation.

#### R3-2. MINOR — `apps/desktop-notifier/README.md:48` still documents `stage` as a legal `ENV`, which the daemon now refuses to start on

`apps/desktop-notifier/README.md:48`

```
| `ENV` | `dev` | one of `local`, `dev`, `qa`, `stage`, `prod`; stamped on every log record |
```

Two lines below, the same README says *"`NOTIFIER`, `LOG_LEVEL` and `ENV` are closed sets and an
unrecognized value **fails startup***" — so the table contradicts its own caption. `config.spec.ts:47`
asserts `parseConfig({ ENV: "stage" })` is a `Left`, and `config.ts:63` is a `Schema.Literal` over
`staging`. A user following the README's own table gets `Invalid daemon configuration: DaemonConfig └─
["env"] …` and exit 1.

I grepped every `.ts`, `.tf`, `.md`, `.json`, `.hcl` and `.example` in the repo for word-boundary
`stage`: this is the **only** dangling value. Everything else — `config.ts`, `config.spec.ts`, both
`variables.tf`, `CLAUDE.md`, `feature.md`, `NOW.md` — is consistent, and the two remaining `stage`
mentions in `config.ts:21` and `config.spec.ts:45` are deliberate references to `logging.md`'s spelling
in an explanation of why this project differs. **The unification is otherwise genuinely complete in both
halves.**

**Proposed fix:** `one of `local`, `dev`, `qa`, `staging`, `prod``.

#### R3-3. MINOR — the loop-shape rationale is measurably wrong in `CLAUDE.md`, and `daemon.ts` still carries the opposite overclaim

`CLAUDE.md:59-60`; `apps/desktop-notifier/src/daemon.spec.ts:224-227`;
`.agents/plans/bootstrap-and-iac/feature.md:202-203`; `apps/desktop-notifier/src/daemon.ts:38-42`

Three places now state, as measured fact:

> *"…heap retention does not diverge because the call is in tail position."*

Measured (table above): it diverges linearly and without bound at **~97 bytes/tick** — 9.4 MB over
100 000 ticks, 37.5 MB over 400 000. This matters most in `CLAUDE.md`, because there the sentence is the
stated **justification for having no test**, sitting directly under the rule *"a long-running loop must
not chain each iteration's promise to the next."* A future contributor who reads "heap retention does not
diverge" has been handed the argument that the banned shape is harmless — which is the opposite of the
lesson the paragraph exists to teach, and it is the only place in this repo that rule is written down.

Meanwhile `daemon.ts:38-42` — untouched since the R1 round — still asserts the framing the agent's own
dispute retracts:

```
 * would chain every tick's promise to the next … so one pending promise and one async frame (each
 * closing over the whole dependency set) would be retained per tick, forever.
```

The frame and its captures are **not** retained (measured: fattening the per-tick state by 800 B moves
the leak by zero). So the repo now carries two mutually inconsistent accounts of the same phenomenon,
each wrong in a different direction, and neither matches the measurement.

**Proposed fix** — one sentence in each of the four sites, saying the same true thing:

> The closed-over state *is* collected (the recursive call is in tail position), but the chain of
> pending promise objects is not: measured at ~97 bytes/tick, linear and unbounded — ~280 KB/day at the
> 30 s default, ~8 MB/month, for the life of the process. Cheaper than "an async frame per tick", but
> not free, and it never stops growing.

`NOW.md`'s entry is append-only history and correctly records what was believed at the time; leave it,
or append a correction as a new entry rather than editing it.

#### R3-4. MINOR — the R2-1 follow-up row names the weakest trigger and omits the one the dependent plans actually specify

`.agents/plans/bootstrap-and-iac/feature.md:178`; `.agents/plans/github-integration/github-event-mapping.md:75,211`

The row's concrete example is *"a producer stamping one batch with a single `toISOString()` and
PutObject-ing sequentially"* — which reads as a coincidence a reader would rate low-probability. The
stronger trigger is already written down in a dependent plan and is not mentioned:

> `github-event-mapping.md:75` — *"the **notification** path uses `updated_at` from the object."*
> `github-event-mapping.md:211` — *"validate `NotificationSchema`, `timestamp = updated_at`…"*

GitHub's notification `updated_at` is **second-precision** (`2026-07-19T20:39:12Z`). Normalised into the
contract's mandatory `.000` fraction, every notification in a batch that shares a second shares a
millisecond — so same-instant siblings are the *norm* for the first planned producer, not a coincidence,
and the loss then needs only a poll landing mid-batch. `claude-code-integration/feature.md:123` already
independently anticipates *"machine clock skew on the timestamp key"*, i.e. route (b).

This is a record-accuracy finding, not a code one: the mechanism is described correctly and completely,
and `packages/event-model/README.md` § *"Key order is not write order"* puts the warning exactly where a
producer implementer will meet it, with a pointer to this row. Only the **likelihood** is understated,
and likelihood is what a reader triages a follow-up by.

**Proposed fix:** one clause in the row's (a) — *"…and, more commonly, when the producer's upstream
timestamp is second-granular: AWE-154's resolved mapping decision sets `timestamp = updated_at` from the
GitHub Notifications API, whose values carry no fractional part, so a batch sharing a second becomes a
batch sharing a millisecond."* Do **not** implement the lookback window here; the deferral is correct
and correctly reasoned.

#### R3-5. NIT — the story files' R1-fix sections were not reconciled with the R2 round, and three claims have gone stale

| Site | Claim | Reality |
| :--- | :--- | :--- |
| `feature.md:135` | *"173 specs green, verified uncached with `--force`"* | **182** passed / 5 skipped, measured with `--force` on all four tasks |
| `desktop-notifier-daemon.md:306` | *"Spec count rose 60 → 86 passing (91 including the five opt-in specs)"* | **95 passing / 100 total** after the R2 round added the probe and vocabulary specs. R2-10 corrected this number once; it has drifted again |
| `desktop-notifier-daemon.md:319` | the loop fix is *"now guarded by a `ticking` flag plus a new spec asserting ticks settle independently"* | that spec was **renamed and its claim retracted** by the R2-4 disposition — this sentence now asserts a guarantee the branch deliberately decided it cannot provide |
| `desktop-notifier-daemon.md:338-341` | *"the accepted `env` set adds `local` to `.agents/guidance/logging.md`'s four"* | superseded by the one-vocabulary carve-out, which also changed `stage` → `staging` |

Separately, `infra-s3-and-dns.md` carries **no record of the R2 round at all** — the module `validation`
blocks and the `env` validation lifted into `bootstrap` are AWE-151 changes that live only in
`feature.md`'s R2 section and `NOW.md`. `feature.md` is a legitimate altitude for *dispositions*, but a
reader opening the story to see what happened to its Terraform will not find it.

Under-claiming rather than over-claiming, so nothing here is dishonest — but these files are the merge's
audit trail, R1 corrected four claims in them and R2 corrected two more, and each round has left the
previous round's sections un-reconciled.

**Proposed fix:** update the four numbers/claims above, and add a short `## R2 review fixes` section to
`infra-s3-and-dns.md` (and optionally `desktop-notifier-daemon.md`) mirroring the R1 ones. Better still,
stop restating counts in prose and say *"see the `## Execution status` table"*.

#### R3-6. NIT — `index.ts:50` is a fall-through `if` the carve-out does not cover, introduced by the commit that fixed R2-9

`apps/desktop-notifier/src/index.ts:50-56`

```ts
if (bucket._tag === "BucketProbeInconclusive") {
  logger.warn("Could not confirm the event bucket; …", { … })
}
```

`CLAUDE.md` scopes the exemption precisely: *"This exemption covers guards that return or throw
immediately, nothing more."* This one logs and continues. It is the only such site left in the diff — I
walked all ten `if` statements in `src/`; the other nine either return/throw immediately or already carry
an `else`. Commit `d2a9198` fixed R2-9's instance in `daemon.ts:67` and created this one in the same
commit, which is the third consecutive round in which this rule has eroded in the newest code (R1 #19 →
R2-9 → here).

**Proposed fix:** the same two-branch form used at `daemon.ts:67-73`, or hoist it into a named predicate.

#### R3-7. NIT — `newer_noncurrent_versions_kept >= 0` admits `0`, which S3 rejects, against the module's own stated contract

`infra/modules/hardened-bucket/variables.tf:52-55`

The module header states the contract plainly: *"every input is validated here rather than at apply time
against real AWS — a bad value should fail `terraform validate`, not leave a half-created bucket."*
`newer_noncurrent_versions >= 0` lets `0` through, and the AWS provider documents
`newer_noncurrent_versions` as *must be a non-zero positive integer* (S3's valid range is 1–100).

Verified offline — a scratch root in a temp directory calling the real module with
`newer_noncurrent_versions_kept = 0`:

```
$ terraform validate
Success! The configuration is valid.
```

No AWS call, nothing applied. Both real call sites pass 5 and 20, so nothing is broken today; it is one
value short of the contract the module advertises. The upper bound (100) is also unenforced.

**Proposed fix:** `condition = var.newer_noncurrent_versions_kept >= 1 && var.newer_noncurrent_versions_kept <= 100 && floor(…) == …`.

---

### Residual risk carried into the integration branch

**R2-1 is the one known-unfixed defect, and it is adequately recorded.** Judged against "would a future
implementer reading only these files understand the hazard", the answer is yes, in four places that
compound rather than duplicate:

- `poller.ts:3-23` — the normative statement, now accurate on both counts it previously inverted, and it
  goes further than R2 asked by explaining why `LastModified` is not simply the safer swap.
- `poller.spec.ts:42-68` — a labelled characterization suite pinning **both** loss routes, so the
  follow-up fix must turn them red and update them consciously rather than discovering the gap.
- `packages/event-model/README.md` § *"Key order is not write order"* — the highest-value placement,
  because every producer imports this package, and it points at `feature.md` § Follow-up candidates.
- `feature.md:178` — the disposition, with the proposed fix (lookback window + delivered-key set), the
  reason for deferral (it is the same product decision as #12), and an explicit *"deliberately not
  implemented on this branch"*.

No overclaiming was found anywhere: nothing says the loss window is closed, nothing says the mark is
write-ordered, and the `advanceMark` docblock explicitly hands the reader back to the module docblock.
The single gap is the **likelihood** framing (**R3-4**), which matters because the batch-write shape that
triggers it is not hypothetical — it is written into `github-event-mapping.md`'s resolved decisions.

Follow-ups **#11, #12, #15, #20** are each recorded with an accurate description and a stated reason for
deferral; I re-confirmed #11's premises still hold and did not find any of the four mischaracterised.
#12 and R2-1 correctly share one open product question rather than being filed as two engineering tasks.

### Honesty and fence audit

**Fence: clean.** No `terraform apply` was executed and nothing in the diff records one having been. No
`*.tfstate`, `*.tfplan`, `backend.hcl`, or `.terraform/` is tracked, and `.gitignore` covers all of them
while correctly keeping `.terraform.lock.hcl`. Every `terraform apply` string in the diff is a runbook
step, a deferred-verification command, or the `deploy` npm script. No credentials, keys, `AKIA`/`ASIA`
prefixes, `.env`, `.claude/`, or `AGENTS.md`. `.gitignore` ignores the AI-config symlink trees while
leaving `.agents/plans/` tracked, and `CLAUDE.md` is deliberately not ignored — both per the user's
staging rules. The statement that **no NS records were written into the live
`fifthdimensionengineering.com` zone** is consistent with every artefact in the diff. Working tree clean,
no upstream configured, no remote ref contains the tip: **nothing pushed.**

**Plan-file accuracy.** Every `## Deferred verification` row in both stories is accurate and correctly
scoped; the `-chdir` corrections are right and the commands are copy-pasteable; "What WAS verified
locally" still correctly separates what ran against the built daemon from what ran in the unit suite. The
`Plan: 8 to add, 0 to change, 0 to destroy` claim remains consistent — the R2 round added only
`validation` blocks, which change no resource. The acceptance-criteria table is accurate except for the
spec count (**R3-5**). The ADR's three-file structure, revision log and state-changes table conform to
`.agents/guidance/adr.md`, and neither R2 change altered the decision, so no new revision entry is owed.

**Statuses conform to `planning-artifacts.md` §3.** AWE-149 and AWE-150 `Completed`; **AWE-151 and
AWE-152 `Implementation Adjustment`** — correctly non-terminal, because the fence blocks their live
verification and the guidance's `Completed` transition is *"verified & merged"*. `feature.md` is
`Implementing`, which is what the command-driven rule produces while any child is non-terminal, and the
file states the reason explicitly rather than leaving it to be inferred. The invariant *"never leave a
feature `Completed` while it owns a non-terminal story"* holds.

### What was checked and found clean (beyond R1's and R2's lists)

- **The `BucketProbeInconclusive` branch is correct at the boundary**, not just in the happy path: a
  status of `undefined` (transport), `>= 500`, or a 4xx not in `bucketFailuresByStatus` (e.g. a 400) all
  land inconclusive, so only the three statuses that genuinely answer *"does this bucket exist here"*
  can kill the process. `bucketFailuresByStatus` remains correctly `Partial` over an open key set.
- **The `dependenciesFor` options-object refactor** removed both hand-rolled `DaemonDependencies`
  literals R2 flagged; every spec now routes through one fixture, and the renamed loop spec gained a real
  second assertion (no further polls after the loop resolves) rather than only losing its false one.
- **`seedMark` interacts correctly with `StartAfter`.** It emits a bare instant, so a key written in the
  same millisecond as the seed sorts *above* it and is still delivered — the loss-avoiding side to err
  on. Worth knowing, since it is the one place the mark is not a full key.
- **The `p(\d)` / `priorityBounds` seam.** `Priority` is 1–8 and the key captures one digit, so `p0`/`p9`
  are structurally matched and rejected by the schema with the range message rather than as a shape
  error — which is what the docblock claims. It would break if the range ever exceeded one digit; the
  comment already owns that trade.
- **Guidance sweep.** No accumulator loops (re-walked every iteration site against `looping.ts`,
  including `parseRecords` and the new `dependenciesFor`); no enums, no `function`, no trailing
  semicolons, explicit return types throughout; every fallible function returns `Either` or a tagged
  union; largest source file is `notify.ts` at 125 lines; `Record` lookups everywhere a discriminator is
  branched on; Gather/Compute/Persist still visible at module level; logging still conforms to
  `logging.md` (per-destination serialization, `env`/`service`/`timestamp` in `defaultMeta`, splat on the
  console line only, every failure log naming the offending value).
- **Terraform.** `fmt -check -recursive` and `validate` clean for all three modules; the module is
  behaviourally equivalent to the pre-refactor roots (re-derived independently); `dynamic "rule"` on
  `length(var.transitions) > 0` correctly emits nothing for the bootstrap bucket; the `depends_on` from
  the lifecycle configuration to versioning is the right fix for plan flapping; provider inheritance and
  `default_tags` flow correctly into the child module; the destroy-order warning (NS record before child
  zone) and `force_destroy = false` on both buckets are the right defaults for a permanent event log.
- **The event-model contract.** All exemplars carry three-digit fractions; `event.spec.ts:43-65` asserts
  lexicographic order equals chronological order *and* that every accepted instant has the same length;
  `event-key.spec.ts` pins injectivity, the `eventType` message, and `p05` rejection. `WorkItemUrl` is
  identity-encoding and nothing downstream assumes a `URL` instance.

### Suggested merge gate

**Nothing blocks the merge.** Fix **R3-1** (one line, and it restores a gate this review is defined by),
**R3-2** (one line, and the README currently tells users to set a value that refuses to start),
**R3-3** (four sentences, and it is the only written statement of a rule the project cannot test), and
**R3-4** (one clause, and it is the difference between a follow-up a reader triages as unlikely and one
they triage as scheduled). **R3-5 to R3-7** are housekeeping and can ride along or follow.

Two questions remain genuinely open for the user and should not be answered by an implementer:
**delivery semantics** (#12 and R2-1 — at-most-once vs retry vs quarantine, and how wide a lookback
window), and the **environment-vocabulary deviation** from `logging.md`. Both are correctly flagged as
awaiting a ruling rather than silently decided.
