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
