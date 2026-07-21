# Automated code review — `github-integration`

Rounds are appended newest-last. Each round is an independent read of
`git diff auto/execute-remaining-bootstrap-github..github-integration` against
`.agents/**`, `CLAUDE.md`, and the feature's own plan files.

---

## R1 — 2026-07-19

Reviewer: independent R1 (did not write the code). Scope: 6 commits, 185 files, ~9 980 insertions —
`packages/integration-core`, `packages/github`, `packages/event-sink`, `apps/webhook-ingest`,
`apps/github-poller`, plus Terraform under `infra/`.

### Verification actually run by the reviewer

| Command | Result |
| :--- | :--- |
| `pnpm install` | up to date, no lockfile change |
| `pnpm build --force` | 7/7 tasks green |
| `pnpm lint --force` | 8/8 tasks green (incl. `@personal-events/infra` → `terraform fmt -check`) |
| `pnpm test --force` | **602 passed / 5 skipped** across 7 packages — matches the claim exactly |
| `pnpm typecheck --force` | 12/12 tasks green (incl. `octokit-alignment.ts`) |
| `terraform fmt -check -recursive infra` | clean |
| `terraform validate` (both roots) | Success / Success |
| `git diff … -- packages/event-model apps/desktop-notifier` | **empty** — Level 0 is untouched; its 87 + 95 = 182 specs are unchanged |

Per-package counts: event-model 87, event-sink 26, integration-core 64, desktop-notifier 95 (+5
skipped), github 129, github-poller 99, webhook-ingest 102.

**turbo `inputs` false-green check (the class found twice in Level 0): passes.** Empirically
verified — editing the *content* of `packages/github/exemplars/webhook-push.json` produced
`@personal-events/github:build: cache miss` **and** `@personal-events/webhook-ingest:test: cache
miss`. The `^build` edge plus `exemplars/**` in `build.inputs` carries exemplar drift to every
consumer. `lint.inputs`' `**/*.tf` covers the new `infra/modules/hardened-bucket/*.tf` and the five
new root files. No new false-green surface found.

**Fence compliance: clean.** No `*.tfstate`, no `.terraform-artifacts/` committed, branch never
pushed (no `origin/github-integration`), no real credentials anywhere (`ghp_classic_token` /
`github_pat_fine_grained` in `config.spec.ts` are obvious placeholders), every network-touching spec
goes through `fakeFetch`/faked `send`. The three "No AWS resource was created…" declarations are
true as far as the tree shows.

### The five things flagged for hardest scrutiny — independent verdicts

**1. The two-bucket rule — diagnosis correct, fix complete in code, invariant NOT enforced.**
The diagnosis is right and I confirmed each step independently: `apps/desktop-notifier/src/poller.ts`
→ `listKeysAfter` calls `paginateListObjectsV2({ Bucket, StartAfter: mark })` with **no `Prefix`**,
and `advanceMark` is `keys.reduce((highest, key) => (key > highest ? key : highest), mark)`.
`"deliveries/"` (`d`, 0x64) and `"state/"` (`s`, 0x73) both sort above `"2026-"` (`2`, 0x32). One
marker strands the notifier past every event that will ever exist. Severity claim is accurate.

The fix is complete on every path I could find: `DeliveryDedupeRepository` and
`PollerStateRepository` are both constructed from `config.stateBucketName`; `S3EventRepository` is
the only thing given `eventBucketName`; `lambda.tf` sets both env vars distinctly; the poller IAM
grants `GetObject`/`PutObject` on `state.…/{poller_state_key}` only. Terraform, README, CLAUDE.md and
three docblocks agree. **No remaining write of operational data to the event bucket.**

But it is documented, not enforced — see finding **R1-5**. A future integration reintroduces it with
one wrong constructor argument, and nothing fails.

**2. `GithubWebhookIntegration.handle` order of operations — all four orderings hold.** Verified in
code: `isAuthentic` (line 59) precedes `parseJsonBody` (inside `ingest`, line 97); the `ping` check
(62) precedes `dedupe.seen` (70); `dedupe.seen` precedes `ingest`; `dedupe.record` (125) runs only
on the `PutEventsSuccess` branch. Each has a real failure mode if reordered, and three of the four
are pinned by guards that *can* fail — `does not consult the dedupe store before the signature is
verified` (asserts `HeadObjectCommand` count 0), the ping case (asserts both `HeadObject` and
`PutObject` counts 0), and the persist-failure case (asserts no `PutObject` into `stateBucket`).
Only "verify before parse" lacks a direct discriminating spec; the security property it protects is
covered by `rejects a valid signature over a body that was then altered`. Acceptable.

**3. `WebhookSecretRepository` not caching a failure — genuinely correct.** `this.cached ??=
this.fetch().catch(cause => { this.cached = undefined; return Promise.reject(cause) })`. The `??=`
assignment completes synchronously; the `catch` handler runs in a later microtask and clears the
memo, so a transient failure recovers on the next call and concurrent callers still share one
in-flight read. `webhook-secret-repository.spec.ts` pins it with a script that fails call 0 and
succeeds call 1, asserting **two** SSM calls. The *rationale* in the docblock is wrong, though — see
**R1-11**.

**4. `source-cycle.ts`'s "advance state only after a successful write" — holds on every path.**
`onItems` returns before `deps.state.save` on `PutEventsFailure`; `onNotModified`/`onRateLimited`/
`onFailure` never save; a `save` that itself throws propagates to `runSourcePoller`'s catch, leaving
the previous state intact. Partial-batch failure inside `Promise.all` leaves some objects written,
but keys are a pure function of the event, so the retry rewrites the identical key — idempotent.
Two specs pin it and both can fail (`s3.stored.has(stateKey) === false`, and 4 puts over 2 cycles).
**However**, the *sibling* invariant claimed one file over — `poller-state.ts`'s "the two source
loops … cannot clobber each other's cursor" — is false. See **R1-4**.

**5. The hand-authored exemplars.** The `Aligned<Upstream, Subset>` trick in `octokit-alignment.ts`
is sound and it really does run (`tsc --noEmit` covers the file, and the subset schemas are narrow
enough that `webhook-pull-request-opened extends PullRequestEventSchema.Type` is a meaningful
claim). What it buys is **names and types on five of the six modelled events** — nothing at all for
`GenericWebhookSchema`, nothing for the Notifications or Events API shapes (no octokit type is
asserted for either), and nothing about values. AWE-154 states this limit accurately ("This covers
field **names and types**; it cannot cover values GitHub actually sends") and its single deferred
row is the right one. **Not over-claimed** — with one exception: the exemplars carry a second-order
factual claim about `created_at` precision that turned out to be wrong (**R1-3**), which is exactly
the kind of thing a real capture would have settled.

### The two other reported catches

**The `unref()` poller exit — real, correctly fixed, and now pinned.** `cancellableSchedule` holds a
ref'd `setTimeout` and clears it on `abort`. Between polls that timer *is* the only handle, so the
diagnosis is right. `source-poller.spec.ts` (9 specs) drives an injected schedule, so the fix is not
directly regression-guarded — but the abort half is, and the story is honest that it was found by
running the binary rather than by a spec. Acceptable.

**Notification triggers over-specified via `subject.type` — correctly fixed and well pinned.**
`NotificationTriggerSchema` carries `reason` only, and `mapping-validation.ts` decodes every rule's
trigger against the real union with `onExcessProperty: "error"` *before* the framework's open schema,
so a rule naming `subjectType` now fails at load rather than validating and never firing. This is
the strongest piece of work in the feature: it closes a criterion ("non-confusable") that the story
admits was previously documentary only.

### The known ordering hazard

**Not made worse, and the recording is *mostly* accurate.** No path synthesises a shared timestamp:
`normalizeWebhook` takes an injected per-delivery `receivedAt`, `normalizeNotification` takes the
item's own `updated_at`, `normalizeEventsApi` takes the item's own `created_at`. `toCanonicalInstant`
widens rather than invents. `nextSince` deliberately does not advance past what was seen.

Two problems with the recording itself: the Events API is claimed to be immune and is not
(**R1-3**), the characterization spec is a tautology (**R1-6**), and neither the feature plan nor the
ADR notices that same-second siblings can produce an *identical whole key*, not merely an identical
leading segment (**R1-2**).

### Plan-status honesty

AWE-153 `Completed` is **justified with one caveat**: every criterion is verifiable without side
effects and every one is exercised by a spec — except the criterion "`SourceAdapter` … a webhook
handler or a poller both satisfy it", which nothing in the repo demonstrates and which the two
concrete edges built later in this same feature actively refute (**R1-9**). That is a stale claim
rather than a dishonest status; the story predates both edges.

The four `Implementation Adjustment` stories' `## Deferred verification` tables are accurate,
specific, and the closing commands are correct and runnable as written (I checked the `terraform
-chdir=` paths, the output names against `outputs.tf`, and the SSM parameter name against
`github-webhook.tf`). Nothing is marked met that was not verified. Two gaps are *omissions* rather
than overclaims — the two Terraform constructs in **R1-7** and **R1-8** are apply-time-only and
belong in AWE-155's/AWE-157's tables.

Counts drift slightly (AWE-154 says "110 specs, 7 files"; `packages/github` now has 129 across 8,
because AWE-157 added `events-api.spec.ts`). Cosmetic, and the direction is upward.

### Findings

| # | Severity | Category | Where |
| :-- | :--- | :--- | :--- |
| R1-1 | blocker | correctness | `apps/github-poller/Dockerfile` |
| R1-2 | blocker | correctness | `packages/event-sink/src/s3-event-repository.ts` / key scheme |
| R1-3 | major | honesty | `packages/github/src/normalizer.ts:60-63` |
| R1-4 | major | correctness | `apps/github-poller/src/poller-state.ts:43-49` |
| R1-5 | major | test-quality | `…/delivery-dedupe-repository.spec.ts:14` + IAM |
| R1-6 | major | test-quality | `packages/github/src/instant.spec.ts:46` |
| R1-7 | major | correctness | `infra/personal-events/github-poller-iam.tf:33-44` |
| R1-8 | major | correctness | `infra/personal-events/apigateway.tf:70` |
| R1-9 | major | design | `packages/integration-core/src/source-adapter.ts` |
| R1-10 | minor | correctness | `packages/integration-core/src/channel.ts:101` |
| R1-11 | minor | honesty | `…/webhook-secret-repository.ts:12-15` |
| R1-12 | minor | honesty | `packages/event-sink/src/s3-client.ts:16-19` |
| R1-13 | minor | efficiency | `packages/event-sink/src/s3-event-repository.ts:58-63` |
| R1-14 | minor | correctness | `apps/github-poller/Dockerfile:22` |
| R1-15 | nit | test-coverage | `apps/github-poller/src/daemon.ts` |

Detail for each is in the structured review output returned to the orchestrator; the two blockers
are restated here because they are the merge gate.

### Full finding detail (R1-1 … R1-15)

### BLOCKER — correctness — apps/github-poller/Dockerfile:36

**The poller's Docker runtime stage ships only `dist/`, but the bundle externalizes every runtime dependency — the image dies on ERR_MODULE_NOT_FOUND before logging a line, and the comment above the COPY asserts the opposite.**

**Why:** `apps/github-poller/tsup.config.ts` has no `noExternal`, so tsup externalizes everything in `dependencies`. I read the emitted artifact to confirm rather than inferring: `apps/github-poller/dist/index.js` is 24 KB and begins `import { createS3Client, probeEventBucket, S3EventRepository } from "@personal-events/event-sink"`, and also imports `@personal-events/github`, `@personal-events/integration-core`, `@personal-events/event-model`, `effect`, `winston`, `@aws-sdk/client-s3`. The runtime stage is `COPY --from=build /repo/apps/github-poller/dist ./dist` with no `node_modules` and no `package.json`, then `CMD ["node", "--enable-source-maps", "dist/index.js"]`. That process cannot resolve a single one of those specifiers. The Dockerfile comment two lines above says "The bundle is self-contained apart from Node itself; tsup resolves the workspace packages into it" — a false statement of fact that a reader (and the next agent) will rely on. AWE-157's deferred-verification table covers only "The Dockerfile builds", which the build stage would; it is the *run* that fails, so this is not covered by the fence. AWE-157 is the entire no-admin path into the system, and Railway is its only delivery mechanism.

**Proposed fix:** Add `noExternal: [/.*/]` to `apps/github-poller/tsup.config.ts`, mirroring `apps/webhook-ingest/tsup.config.ts` which already does exactly this and documents the size-for-determinism trade. Alternatively keep the deps external and have the build stage emit a deployable tree (`pnpm deploy --filter @personal-events/github-poller --prod /app`), copying `/app/node_modules` and `/app/package.json` into the runtime stage alongside `dist/`. Either way, correct the "self-contained" comment to say what is actually true, and change AWE-157's deferred row from "The Dockerfile builds" to "`docker build … && docker run` reaches the `github poller started` line", since building was never the risk.

### BLOCKER — correctness — packages/event-sink/src/s3-event-repository.ts:58

**Two distinct events that share a second and a classification produce a byte-identical S3 key, so the second PutObject silently overwrites the first — permanent loss that this feature makes routine and that is recorded nowhere.**

**Why:** The key is `{timestamp}.{type}.p{priority}.{source}.{name}.json` with no per-item identity (`packages/event-model/src/event-key.ts:52`). This feature ships the system's first producers, and both poller channels are second-precision: `normalizeNotification` takes `updated_at` (exemplars `notification-mention.json` and `notification-review_requested.json` both carry `2026-07-19T19:02:11Z`) and `normalizeEventsApi` takes `created_at` (`events-api-push.json`: `2026-07-19T19:14:52Z`). `toCanonicalInstant` widens both to `.000`. `name`/`eventType`/`priority` come from `github-mapping.json` keyed only on `reason` / `type`+`action`, so two `mention` notifications, or two `PushEvent`s, or two `review_requested` items in the same second collapse onto one key. `putObjects` issues both puts, reports `{_tag: "PutEventsSuccess", count: 2, keys: [k, k]}`, `source-cycle.ts` advances the cursor and the seen-set, and one event is gone from permanent history with no error anywhere. This is a *different* defect from the recorded ordering hazard — that one is about a consumer skipping a sibling that still exists in the bucket; this one destroys the object. It appears in neither `feature.md` § Follow-up candidates, nor the ADR's `## Known limitation carried, not solved` (which says only that such keys "sort adjacently and … indistinguishably by time"), nor `packages/event-model/README.md` (which asserts the opposite: "one object key denotes one event"). The suite cannot see it: `source-cycle.spec.ts:59` counts `PutObjectCommand`s, and the two exemplars it uses are saved only by mapping to different `name`s.

**Proposed fix:** At minimum, record it honestly before merge: add it as follow-up #3 in `.agents/plans/github-integration/feature.md` and as a second bullet under the ADR's `## Known limitation`, framed with the same at-most-once / retry-until-delivered / quarantine decision as follow-up #1, and correct `packages/event-model/README.md`'s "one object key denotes one event" claim which is now false in practice. Add a failing-if-broken spec: normalize two same-second same-`reason` notification items through `runSourceCycle` and assert on `s3.stored.size` (not `eventPuts(s3).length`), so the collapse is visible. The actual fix is an `event-model` change — append a short stable disambiguator derived from the provider item id to `name` (e.g. `mention-18442310988`) or add a key segment — which is the user's product call, not this feature's.

### MAJOR — honesty — packages/github/src/normalizer.ts:60

**The Events API channel is documented in three places as not sharing the second-precision hazard; the package's own exemplar shows `created_at` is second-precision, so it shares it exactly.**

**Why:** `normalizer.ts:60-63` states: "unlike the notifications path the instants are genuinely distinct per item — this source does **not** collapse a batch onto one millisecond." `.agents/plans/github-integration/github-notifications-poller.md` repeats it as a design decision ("The Events API path does not share the notifications timestamp hazard"), and `events-api.spec.ts:57` encodes it in a spec name ("— unlike the notifications inbox"). All three are false. `packages/github/exemplars/events-api-push.json` has `"created_at": "2026-07-19T19:14:52Z"` and `events-api-pull_request-opened.json` has `"created_at": "2026-07-19T18:44:30Z"` — GitHub's Events API emits second precision, identically to the Notifications inbox, so `toCanonicalInstant` widens both to `.000` and two activity items created in the same second are indistinguishable. The review brief asked specifically whether the hazard recording is accurate; for one of the two affected channels it is not, and the inaccuracy directly understates the blast radius of both follow-up #1 and finding R1-2. The spec that carries the claim in its name cannot detect the error either — it compares two exemplars whose `created_at` values differ by half an hour, so it would pass under any implementation.

**Proposed fix:** Correct all three sites to say that the Events API is second-precision too and therefore shares the hazard; the only channel that does not is the webhook path, whose `receivedAt` is an injected `new Date().toISOString()`. Rename `events-api.spec.ts:57` to state what it actually tests ("takes each item's own created_at rather than a batch-shared instant") and add a sibling spec over two items constructed with the same `created_at` second that asserts the identical normalized timestamp — a characterization that can fail. Then fold the events_api channel into follow-up #1's scope in `feature.md` and the ADR, which currently name only the notifications poller.

### MAJOR — correctness — apps/github-poller/src/poller-state.ts:43

**`withSourceState`'s docblock claims the two concurrent source loops cannot clobber each other's cursor through a stale read; they can — both cycles read the whole state object at cycle start and write it whole at the end, a textbook lost update.**

**Why:** The docblock says: "Written as a replace-one-branch merge so the two source loops, which run concurrently, cannot clobber each other's cursor through a stale read of the sibling's branch." The merge shape is necessary but nowhere near sufficient. `runSourceCycle` (`source-cycle.ts:59`) does `const state = await deps.state.load()` at the top and `deps.state.save(withSourceState(state, …))` at the bottom, where `state` is the object loaded at the *start of this cycle*. `startDaemon` starts both `runSourcePoller` loops in one process against one `PollerStateRepository` writing one S3 key (`state/github-poller.json`), and their intervals (60 s and 300 s) overlap every fifth tick by construction. Interleave: notifications loads S0 at T0; events loads S0 at T0+ε, finishes, saves S1 (events branch advanced); notifications finishes at T1 and saves S0-plus-its-own-branch, reverting the events branch to T0. The events source then re-polls with a stale ETag and a rolled-back seen-set, re-writing events it already wrote. Because keys are deterministic those rewrites are idempotent, so the damage is wasted GitHub rate-limit budget and wasted PutObjects rather than corruption — but the stated invariant is simply not true, and the next person to reason about concurrency here will trust it. No spec covers concurrent cycles; `writes into its own branch … leaving the sibling source untouched` runs a single cycle sequentially.

**Proposed fix:** Either make the claim true or delete it. Cheapest correct fix: give each source its own state object (`state/github-poller-notifications.json` / `-events.json`), which removes the shared mutable resource entirely and costs one extra `s3:GetObject`/`PutObject` per cycle — note this requires widening the poller's IAM statement in `github-poller-iam.tf` from the single key to a `state/github-poller-*` pattern. Alternatively re-read state immediately before `save` and merge only the current source's branch, and add a spec that runs two cycles with interleaved load/save to prove it. Whichever is chosen, rewrite the docblock to describe what is actually guaranteed.

### MAJOR — test-quality — apps/webhook-ingest/src/integrations/github/delivery-dedupe-repository.spec.ts:14

**The two-bucket invariant is documentation-only: the one spec asserting it is a tautology over a value the fixture itself supplied, and no IAM condition, bucket policy, or type prevents a future integration from writing operational keys into the event bucket.**

**Why:** The spec is `it("uses the state bucket, never the event bucket — a marker there would strand every consumer", () => { expect(fakeAws().dedupe.bucket).toBe(stateBucket) })`, and `fakeAws()` constructs the repository as `new DeliveryDedupeRepository(s3, stateBucket, deliveryPrefix)` two files away. It asserts that a constructor stores its argument. Change `register.ts` to pass `config.eventBucketName` — the exact regression the whole edifice exists to prevent — and this spec still passes, because nothing about `register.ts` is on its path. This is the "regression guards that cannot fail" class the prior three rounds already found twice. The invariant is unenforced elsewhere too: `lambda.tf`'s `WriteEvents` statement grants `s3:PutObject` on `${module.event_log.arn}/*` with no key condition, `github-poller-iam.tf`'s `AppendEvents` likewise, and `stateBucketName`/`eventBucketName` are both plain `string` so the compiler cannot tell them apart. The rule is stated in CLAUDE.md, three docblocks, `state-bucket.tf` and `infra/README.md` — five documents and zero mechanisms. AWE-156's write-up claims "A spec asserts the repository writes to the state bucket", which is true only in the tautological sense.

**Proposed fix:** Move the assertion to where the wiring decision is actually made: in `register.spec.ts`, call `registerGithub({ …, stateBucketName: stateBucket })` with an `IntegrationDeps` whose `events` repository points at `eventBucket`, then assert `integration.deps.dedupe.bucket === stateBucket && integration.deps.dedupe.bucket !== integration.deps.events.bucket`. That guard fails the moment someone passes the wrong name. Add the machine-checked half too: a `Deny` statement on the event bucket's producer policies with `StringNotLike s3:prefix`/resource `arn:…:events…/2*` (event keys always lead with a four-digit year), so IAM refuses an operational key regardless of what the code asks for. Consider branded `EventBucketName` / `StateBucketName` string types in `event-sink` so the mistake is a compile error before the Claude Code integration builds on this template.

### MAJOR — test-quality — packages/github/src/instant.spec.ts:46

**The characterization spec for the second-precision hazard is `f(x) === f(x)` on the same literal input — it is true for every possible implementation and cannot fail.**

**Why:** `it("gives two same-second notifications the identical instant — same-instant siblings are the norm here", () => { expect(toCanonicalInstant("2026-07-19T19:02:11Z")).toStrictEqual(toCanonicalInstant("2026-07-19T19:02:11Z")) })`. Both sides pass the byte-identical string to a pure deterministic function; `toStrictEqual` then compares two structurally identical `Either.right`s. Replace the body of `toCanonicalInstant` with `Either.right("x")` and this spec still passes. It is presented — in a four-line docblock directly above it — as the pin on the single most consequential known limitation in the feature, and `feature.md` § Follow-up candidates cites `instant.spec.ts` as where the behaviour is "pinned by characterization specs". Same class as R1-5, and the same class the prior rounds flagged twice.

**Proposed fix:** Make the two inputs differ in exactly the dimension the hazard is about, so the assertion has content: `expect(toCanonicalInstant("2026-07-19T19:02:11Z")).toStrictEqual(toCanonicalInstant("2026-07-19T19:02:11.000Z"))` fails if the widening ever changes. Better still, characterize it end-to-end where it actually bites — in `normalizer.spec.ts`, assert that `normalizeNotification(readGithubExemplar("notification-mention.json")).timestamp === normalizeNotification(readGithubExemplar("notification-review_requested.json")).timestamp`, which is true today (both are `19:02:11Z`), is the real hazard, and breaks loudly the day someone "fixes" precision without deciding delivery semantics.

### MAJOR — correctness — infra/personal-events/github-poller-iam.tf:39

**The poller's `ProbeEventBucket` grant conditions `s3:ListBucket` on `s3:prefix = ""`, but `HeadBucket` supplies no `s3:prefix` context key — the Allow will not match and every start-up probe will be denied.**

**Why:** `probeEventBucket` (`packages/event-sink/src/s3-client.ts:42`) sends `HeadBucketCommand`, which S3 authorizes against `s3:ListBucket`. `HeadBucket` has no prefix parameter and therefore does not populate the `s3:prefix` request-context key. An IAM `StringLike` condition on a context key that is absent from the request evaluates to false, so the statement does not apply and the implicit deny stands. The `s3:prefix = ""` idiom is for constraining `ListObjectsV2` to the bucket root, not for `HeadBucket`. Consequence at run time: `toProbeFailure` sees a 403, classifies it `BucketUnreachable`, and `reportBucketProbe` logs `error: "event bucket is not usable; every write will fail until this is fixed"` on every single container start — while writes in fact work fine, because `AppendEvents` grants `s3:PutObject` unconditionally. A permanent false alarm at the top of every log is worse than no probe: it trains the operator to ignore the one line that matters. This is apply-time-only and cannot be caught by `terraform validate`, and it is absent from AWE-157's `## Deferred verification` table, whose closest row ("The IAM user's policy is sufficient and not excessive") would only surface it incidentally.

**Proposed fix:** Drop the condition block from the `ProbeEventBucket` statement — `s3:ListBucket` on `[module.event_log.arn]` with no condition is already tightly scoped (it grants listing one bucket and nothing else, and the `AppendEvents` statement deliberately withholds `s3:GetObject` so history still cannot be read). If you want to keep list-scoping intent documented, do it in a comment rather than a condition that silently voids the grant. Then add an explicit row to AWE-157's deferred table: "the start-up bucket probe succeeds against the real IAM user — expect `event bucket reachable`, not `event bucket is not usable`".

### MAJOR — correctness — infra/personal-events/apigateway.tf:70

**`aws_lambda_permission.ingest`'s `source_arn` ends with the literal `{integration}` path-variable placeholder rather than a wildcard, which risks a 403 on every real delivery and is not in any deferred-verification table.**

**Why:** `source_arn = "${aws_apigatewayv2_api.ingest.execution_arn}/*/*/{integration}"`. API Gateway constructs the `AWS:SourceArn` it presents to Lambda from the invocation as `{execution-arn}/{stage}/{method}/{path}`. For a request to `POST https://hooks.…/github` the path component is the *resolved* `github`, not the route template's `{integration}` — so the literal placeholder would only ever match a request whose path was itself the string `{integration}`. If that is how it resolves, every GitHub delivery gets a 403 from Lambda's resource policy before any code of ours runs, GitHub records the delivery as failed, and (per the feature's own risk register) does not retry it. I cannot settle it under the fence — this is exactly an apply-time behaviour — but the cost of being wrong is total ingest failure, the cost of being conservative is zero, and neither AWE-155's nor AWE-156's deferred table mentions it. Terraform's own `aws_apigatewayv2_*` examples use `"${execution_arn}/*/*"`.

**Proposed fix:** Change to `source_arn = "${aws_apigatewayv2_api.ingest.execution_arn}/*/*"`. That is still scoped to this one API in this one account — which is the property the existing comment correctly identifies as the thing worth having — and it cannot be defeated by path resolution. Independently, add a row to AWE-155's `## Deferred verification`: "the Lambda resource policy admits a real invocation — `curl -XPOST "$(terraform … output -raw ingest_url)/github"` returns 404 from *our* handler (look for `unroutable webhook path` in CloudWatch), not a bare 403 from API Gateway with no log line of ours".

### MAJOR — design — packages/integration-core/src/source-adapter.ts:699

**`SourceAdapter` — a headline export of the reusable template — is implemented by nothing, and both concrete edges built in this same feature explicitly declined it in favour of their own near-equivalent shapes.**

**Why:** AWE-153's acceptance criterion reads: "`SourceAdapter` (something that yields raw provider events — a webhook handler or a poller both satisfy it)", and the story is marked `Completed`. Neither satisfies it. `apps/webhook-ingest/src/webhook-integration.ts` opens by saying so: "Deliberately **not** `integration-core`'s `SourceAdapter`: that interface is pure and synchronous by design, and a webhook edge is neither", and defines its own `WebhookIntegration`. `apps/github-poller/src/source-cycle.ts` defines `SourceDefinition` with `normalize: (item: unknown) => Either<NormalizedEvent, GithubNormalizeError>` — the same idea as `toNormalizedEvents` minus the array, plus `keyOf`/`toEvent`/`nextSince` — and never mentions `SourceAdapter` either. So the template exports an abstraction with a 0/2 adoption rate among the only two implementations that exist, and the two real edges independently invented incompatible replacements. The review brief flags `integration-core` as load-bearing because the Claude Code integration is planned to build directly on it; that integration will hit the same wall and invent a third shape, at which point the template's central promise — "adding a new integration is a new mapping config + normalizer" — is false for everything except classification.

**Proposed fix:** Decide before Claude Code lands. Either (a) delete `SourceAdapter` and the criterion that names it, leaving `NormalizedEvent` + `transform` + `classify` as the honest template surface — which is what the two edges actually reuse and reuse well; or (b) reshape it to what both edges genuinely need: a per-item `normalize: (raw: Raw) => Either<NormalizedEvent, Failure>` plus `channel`/`source`, and have `SourceDefinition` extend it and `GithubWebhookIntegration` compose it, so the interface has at least two real implementors. Whichever, correct AWE-153's criterion so a `Completed` story does not carry an unmet clause, and add a line to the ADR's template section saying what an integration must supply — since the ADR currently lists `SourceAdapter` as part of the decision.

### MINOR — correctness — packages/integration-core/src/channel.ts:101

**`matchKey` joins fields on unescaped `&` and `=`, so a trigger field value containing those characters can forge a different rule's lookup key.**

**Why:** `matchKey` renders sorted entries as `${key}=${value}` joined by `&`, with no escaping. I confirmed a concrete collision by executing the function's logic: `matchKey({channel:"webhook", action:"opened&event=issues"})` and `matchKey({channel:"webhook", action:"opened", event:"issues"})` both produce `webhook:action=opened&event=issues`. A provider whose event identity can contain `&` or `=` can therefore be classified by a rule written for a different trigger — including, in the worst case, a `security_alert` rule being matched by something that is not one, or the reverse. It is unreachable for GitHub today (event names, actions and reasons are `[a-z_]+`), which is why this is minor rather than major. But `TriggerSchema` is deliberately open (`Schema.Record({key: Schema.String, value: Schema.String})`) precisely so the framework can host providers it has never seen, and the next provider is Claude Code, whose trigger fields are far more likely to carry URL-ish or free-text values.

**Proposed fix:** Encode each key and value before joining: `.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)`. It is a one-line change, keeps the key human-readable for the `matchKey` value logged in `TransformError` and in the unmapped-event warning, and is order-independent as before. Add a spec asserting `matchKey({channel:"webhook", action:"opened&event=issues"}) !== matchKey({channel:"webhook", action:"opened", event:"issues"})`. Note this changes no existing key for GitHub, since none of its values contain reserved characters.

### MINOR — honesty — apps/webhook-ingest/src/integrations/github/webhook-secret-repository.ts:13

**The docblock justifying not caching a failed secret read states the failure mode is "a 401 GitHub never retries"; the code and its own spec show it is a 500.**

**Why:** The docblock reads: "A failed read is **not** cached … and because a rejected delivery is a 401 that GitHub does not retry, that is silent, permanent event loss rather than a visible outage." In fact a rejected `secrets.get()` rejects out of `isAuthentic`, out of `handle`, and is caught by `createIngestHandler`'s `.catch`, which logs `webhook integration threw` and returns `serverError()` — HTTP 500. `github-integration.spec.ts:220` pins exactly this ("propagates a secret-read failure so the router answers 5xx rather than silently rejecting deliveries"). The behaviour is correct and the decision not to cache is right; only the stated reason is wrong, and it is wrong in the direction that overstates the danger (a 500 is *visible* in GitHub's delivery log and hand-redeliverable, which is the whole argument `outcome-response.ts` makes for choosing 5xx over a silent 2xx). The same sentence is repeated verbatim in `.agents/plans/github-integration/github-webhook-handler.md` § Other design decisions.

**Proposed fix:** Correct both copies to the real failure mode: caching a rejection would make every delivery on that warm environment answer 500 until AWS recycles it — visible in GitHub's delivery log, but with a three-day manual-redelivery window as the only recovery and the poller as the backstop. That is still a good reason not to cache, and it is the true one.

### MINOR — honesty — packages/event-sink/src/s3-client.ts:16

**The docblock states the duplication with the desktop notifier's S3 client is "recorded as a follow-up in `.agents/plans/github-integration/feature.md`"; no such follow-up exists in that file.**

**Why:** `packages/event-sink/src/s3-client.ts:16-19` says: "**Known duplication.** `apps/desktop-notifier/src/s3-client.ts` predates this package and carries a near-identical probe. Collapsing it into this shared module is recorded as a follow-up in `.agents/plans/github-integration/feature.md`." `feature.md`'s follow-up section contains exactly two entries — `### 1. The ordering hazard …` and `### 2. No specificity ladder …` — and grepping the whole file for `s3-client`, `duplicat` and `probe` returns only unrelated prose. The decision not to collapse it mid-feature is sound (it would move a Level 0 app's specs), but the pointer is dangling: a reader who follows it finds nothing, and the follow-up is consequently not on anyone's list.

**Proposed fix:** Add the follow-up to `.agents/plans/github-integration/feature.md` as `### 3. Two S3 client/probe implementations`, naming both files and stating the reason it was deferred, so the cross-reference resolves. It pairs naturally with the config/logger/error-introspection duplication in the DRY assessment below — one "collapse the app edges onto shared modules" follow-up can cover all of it.

### MINOR — efficiency — packages/event-sink/src/s3-event-repository.ts:60

**`putObjects` fans out an entire batch through `Promise.all` with no concurrency cap, against the project's stated default parallelism of 10.**

**Why:** `Promise.all(objects.map(object => this.putObject(object)))`. For the webhook path the batch is always 1, so this is harmless. For the poller it is a whole page: `GET /notifications` returns up to 50 per page by default and `received_events` up to 30, and after a cold start or a long back-off every item in the page is fresh, so the process opens that many simultaneous `PutObject` connections. `.agents/guidance/api-integrations.md` § "Dealing with downstream parallelism and rate limits" states "The default parallelism level should be set to 10" and "The back-end configuration should have a place to set a default parallelism count". There is no such setting anywhere in the workspace. The docblock's stated reason for `Promise.all` is fail-the-whole-batch semantics, which a bounded pool preserves.

**Proposed fix:** Bound the fan-out while keeping all-or-nothing: chunk `objects` into groups of a configurable `putConcurrency` (default 10) and thread the chunks through `reduce` as a promise chain per `.agents/code-examples/typescript/src/looping.ts` → `sequentialPromises_good`, with `Promise.all` inside each chunk. Surface `putConcurrency` on the `S3EventRepository` constructor so the poller can set it from config, satisfying the "place to set a default parallelism count" requirement. Behaviour on failure is unchanged — the first rejecting chunk fails the batch and the cursor still does not advance.

### MINOR — correctness — apps/github-poller/Dockerfile:22

**`pnpm install --frozen-lockfile` runs with only five of the workspace's seven member manifests copied, which pnpm is likely to reject as a lockfile/workspace mismatch.**

**Why:** The build stage copies `pnpm-workspace.yaml` (which globs `packages/*` and `apps/*`) and `pnpm-lock.yaml` (which contains importer entries for all seven members plus `infra`), but only copies the manifests for `event-model`, `integration-core`, `event-sink`, `github` and `github-poller`. `apps/desktop-notifier`, `apps/webhook-ingest` and `infra` are absent from the image, so pnpm resolves a workspace of five members against a lockfile describing eight importers. `--frozen-lockfile` fails on exactly that kind of divergence ("Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with <workspace>"). AWE-157 honestly defers "The Dockerfile builds", so this is a declared unknown rather than an overclaim — but it is a second independent reason the image is not usable, and it will be hit before R1-1 is.

**Proposed fix:** Copy every workspace member's `package.json` (plus `infra/package.json`) in the manifest layer — they are tiny and copying them all preserves the layer-caching benefit the comment is after — or drop `--frozen-lockfile` in favour of `--lockfile-only=false` for this stage. Verify with the command the story already names: `docker build -f apps/github-poller/Dockerfile .` from the repo root, which is worth running once now that it is cheap.

### NIT — test-coverage — apps/github-poller/src/daemon.ts:42

**`daemon.ts` — the poller's 164-line composition root, and the only place per-source enablement and the bucket-probe reporting are decided — has no spec file.**

**Why:** `apps/github-poller/src` ships seven spec files (backoff, config, dedupe, poller-state-repository, source-cycle, source-poller, source-repositories) and none for `daemon.ts`, even though it holds real branching: token-presence gating of each source loop, the three-way `reports[probe._tag]()` dispatch, and the two early-return paths for bad config and bad mapping config. `.agents/tests.md` opens with "All code should be covered by automated tests." The mitigating factor is real and unusual — the story ran the built binary under four configurations and that is what found the `unref` defect — and `startDaemon` already accepts injected `controller` and `schedule` precisely so a spec could drive it. Compare `apps/webhook-ingest`, whose equivalent `composition.ts` does have a spec (5 tests) covering the misconfigured-app and empty-registry paths.

**Proposed fix:** Add `daemon.spec.ts` mirroring `composition.spec.ts`: pass an `env` with neither token and assert `pollers` is empty and both `… source disabled` warnings plus the `no GitHub token configured` error were logged; pass one token and assert exactly one poller with the right `name`; pass an invalid `env` and assert the `github poller cannot start` line and an empty `pollers`. All three run with an injected `schedule` and an aborted controller, so no timer or network is involved.



**R1-1 — the poller's Docker image cannot start.** `apps/github-poller/tsup.config.ts` has no
`noExternal`, so tsup externalises every `dependencies` entry. I read the emitted bundle: `dist/
index.js` (24 KB) begins `import { createS3Client, … } from "@personal-events/event-sink"` and also
imports `@personal-events/github`, `@personal-events/integration-core`,
`@personal-events/event-model`, `effect`, `winston`, `@aws-sdk/client-s3`. The runtime stage copies
`--from=build /repo/apps/github-poller/dist ./dist` and **no `node_modules`**, so
`CMD ["node", …, "dist/index.js"]` dies on `ERR_MODULE_NOT_FOUND` before a single line of ours logs.
The comment two lines above the COPY asserts the opposite: *"The bundle is self-contained apart from
Node itself; tsup resolves the workspace packages into it."* AWE-157's deferred row covers only *"The
Dockerfile builds"* — the build stage would succeed; it is the run that fails. Fix: add
`noExternal: [/.*/]` to the poller's tsup config (mirroring `apps/webhook-ingest/tsup.config.ts`,
which does exactly this and for the same reason), or `pnpm deploy --filter … --prod /app` and copy
the resulting `node_modules`. Then correct the comment.

**R1-2 — two distinct events can share one S3 key and silently overwrite each other.** The key is
`{timestamp}.{type}.p{priority}.{source}.{name}.json` — no per-item identity. This feature is the
system's first producer, and it makes collision routine rather than rare on **both** poller
channels: `updated_at` and `created_at` are second-precision, so a batch shares a millisecond, and
`name`/`eventType`/`priority` come from a config keyed on `reason`/`type`, so two `mention`
notifications (or two `PushEvent`s) in the same second produce **byte-identical keys**. The second
`PutObject` overwrites the first; `putEvents` still reports `count: 2` with two identical strings in
`keys`, the poller advances its cursor, the dedupe marker records success, and one event is gone
from permanent history with no error anywhere. This is a *different* defect from the recorded
ordering hazard (which is about a consumer skipping a sibling that still exists) and it is not
recorded in `feature.md` § Follow-up candidates, in the ADR's "Known limitation", or anywhere else.
The exemplars sit one field away from proving it: `notification-mention.json` and
`notification-review_requested.json` share `updated_at: "2026-07-19T19:02:11Z"` and are saved only by
mapping to different `name`s. `source-cycle.spec.ts:59` counts `PutObjectCommand`s, not stored
objects, so the suite cannot see it. Minimum bar for merge: record it alongside follow-up #1 with the
same at-most-once-vs-retry framing, and add a spec that writes two same-second same-reason items and
asserts what happens. The real fix is a key disambiguator (a short hash of the provider item id
appended to `name`, or a `seq` segment), which is an `event-model` change and squarely the user's
product decision.

### DRY vs WET

See `dedupAssessment` in the structured output. Headline: the two S3-*writing* paths are genuinely
shared (`event-sink` is the single `PutObject` site for both producers, and the object key exists
once) — that is the most important sharing decision in the feature and it was made correctly. The
duplication that did accrete is in the *edges*: `deploymentEnvs` / `logLevels` / `omitUndefined`
each now exist in **three** app config modules, `capturingLogger` in three testing modules,
`httpStatusOf` in **four** modules, and the winston factory in three. The environment vocabulary in
particular is a CLAUDE.md carve-out that exists precisely to stop the five values drifting, and it
is now declared three times.

---

## R1 fix round — 2026-07-21 (disposition)

Applied by the feature-execution agent, interleaved with a user-directed **AWS-only re-architecture**
(the poller moved from a Railway container to an EventBridge-scheduled Lambda) and a **user-approved
event-model contract change** (`producer` + `eventId`). Per-finding disposition:

| # | Sev | Disposition |
| :-- | :-- | :--- |
| R1-1 | blocker | **Fixed (webhook) / mooted-by-arch (poller).** The webhook Lambda bundle threw `Dynamic require of "util"` at import (winston CJS interop in ESM); a `createRequire` banner fixes it, and `apps/webhook-ingest/src/bundle.spec.ts` imports the emitted zip from a dir with **no `node_modules`** so it fails on this or a missing `noExternal`. The poller's Docker/`noExternal` problem is gone — it is now a Lambda with the same banner + bundle spec. |
| R1-2 | blocker | **Fixed in the contract (not merely recorded).** `event-model` gained `producer` + `eventId`; the key is now `…{name}.{producer}.{eventId}.json`. Reproduced the collision, then fixed it; the poller characterization flipped to "two distinct objects survive"; README says "one object key denotes one event" truthfully. Level 0 updated in step, still green. |
| R1-3 | major | **Fixed.** The Events API is not immune to the second-precision hazard; corrected in `normalizer.ts`, the AWE-157 plan, and the spec name, with a discriminating spec added. |
| R1-4 | major | **Mooted-by-arch.** The concurrent-loop cursor clobber cannot occur: a scheduled Lambda with `reserved_concurrent_executions = 1` reads state once and writes once per invocation. The false "cannot clobber" docblock is gone. |
| R1-5 | major | **Fixed.** `EventBucketName` / `StateBucketName` are branded types, so passing the event bucket where operational state belongs is a **compile error**; the wiring guard moved to `register.spec.ts` where a real regression fails it (proven by injecting the regression). |
| R1-6 | major | **Fixed.** The instant characterization is no longer `f(x)===f(x)`; it is discriminating and mutation-checked. |
| R1-7 | major | **Mooted-by-arch.** The broken `s3:prefix` IAM condition was on the Railway IAM user, which no longer exists; the poller Lambda's role grants `ListBucket` with no condition. |
| R1-8 | major | **Fixed.** `aws_lambda_permission.ingest` `source_arn` changed from the literal `{integration}` to `.../*/*`; a deferred-verification row asserts a real POST returns our 404, not a bare 403. |
| R1-9 | major | **Fixed (reshaped).** `SourceAdapter` (0/2 adoption) deleted; replaced by a `Normalizer` function type — what both edges actually compose and what Claude Code will implement. ADR + docblocks updated. |
| R1-10 | minor | **Fixed.** `matchKey` fields are `encodeURIComponent`-escaped; a value with `&`/`=` can no longer forge another rule's key. No GitHub key changes. Spec added. |
| R1-11 | minor | **Fixed.** The secret-repository docblock (and the AWE-156 plan) now say the failure mode is a visible **500**, not a 401. |
| R1-12 | minor | **Fixed.** The dangling follow-up pointer is resolved: `feature.md` § Follow-up candidates #4 now names the duplicated S3-client/config/logging modules. |
| R1-13 | minor | **Fixed.** `putObjects` is bounded to `putConcurrency` (default 10, the project's stated parallelism), threaded through `reduce`; all-or-nothing preserved. Spec asserts the peak. |
| R1-14 | minor | **Mooted-by-arch.** The Dockerfile's partial-manifest `--frozen-lockfile` problem is gone with the Dockerfile. |
| R1-15 | nit | **Resolved-by-arch.** The old untested `daemon.ts` is gone; the poller's composition root now has `composition.spec.ts` and `poll-once.spec.ts`. |

No finding was disputed. Full uncached `build`/`lint`/`test`/`typecheck` green (615 specs across 7
packages); Level 0's specs still pass; `terraform fmt -check -recursive infra` and `validate` clean on
both roots; a scratch `plan` is `41 to add, 0 to change, 0 to destroy`. Nothing applied or deployed.

---

## R2 — 2026-07-21 (post-rearchitecture)

Reviewer: independent R2 (did not write the code, was not the R1 reviewer). Scope: `de0dbd9..HEAD`
(five code/plan commits, ~2 600 insertions) — the **AWS-only re-architecture** of the poller
(Railway container → EventBridge-scheduled Lambda), the **event-model contract change**
(`producer` + `eventId` in body and object key), the **env-vocabulary change** (`development` /
`production`; consumer poll 10 s), and the R1-fix round. Focus per the brief: the contract change
(key injectivity, dotted-segment grammar, hash stability, redelivery idempotence), the re-arch
(single-object state safety under `reserved_concurrent_executions = 1`), and an audit of every R1
disposition.

### Verification actually run by the reviewer (all green)

| Command | Result |
| :--- | :--- |
| `pnpm install` | clean |
| `pnpm build --force` | 7/7 tasks (exit 0) |
| `pnpm lint --force` | 8/8 tasks (incl. `infra` → `terraform fmt -check`) (exit 0) |
| `pnpm test --force` | **610 passed / 5 skipped** across 13 test tasks — matches the claim exactly |
| `pnpm typecheck --force` | 12/12 tasks (exit 0) |
| `terraform fmt -check -recursive infra` | clean |
| `terraform validate` (bootstrap + personal-events) | Success / Success |

Per-package: event-model **92**, integration-core 68, event-sink 29, desktop-notifier **92 (+5
skipped)**, github 135, webhook-ingest 105, github-poller 89. **Level 0 is intact** — event-model 92
and desktop-notifier 92+5 are exactly the claimed counts, and the contract change that touched them
did not regress either. `turbo.json`'s two `#test` overrides depend on `["^build","build"]` with
`tsup.config.ts` as an input, so both apps' `bundle.spec.ts` runs against a freshly-built artifact
and a banner/`noExternal` change invalidates the cache — the false-green hole is covered for the new
poller too.

**Fence: clean.** No `terraform apply`/deploy/publish/push in the diff; no `*.tfstate`,
`.terraform-artifacts/`, or committed zip; branch never pushed (no `origin/github-integration`); no
real PAT anywhere (both SSM params are `placeholder-set-me-out-of-band` with `ignore_changes =
[value]`). The lookback delivery fix is a **decided** follow-up (`feature.md` §1 → retry-with-lookback,
consumer-side, its own story), not dropped and not half-implemented.

### JOB 1 — the contract change (the load-bearing key)

**The codec is injective and the grammar is sound.** `eventKeyPattern` is anchored, captures the
timestamp as a fixed-width group, priority as a **single** digit (so `p05`≠`p5` cannot alias), and
each of `type`/`source`/`name`/`producer`/`eventId` as `[^.]+`. With every middle segment dot-free
and separated by literal dots, the seven-way split is unambiguous and `buildKey ∘ parseKey` is the
identity. `event-key.spec.ts` pins round-trip, injectivity, and rejection of a dotted/extra/missing
segment. I could not construct two distinct valid events colliding on one key.

**The dotted-segment risk is contained by a real safety net, not by luck.** `NoDotString` rejects a
`.`, and — crucially — `toEventObject` calls `encodeEventJson` (`Schema.encodeEither(EventSchema)`,
which applies the `NoDotString` filter on **encode**) *before* `buildEventKey`, and only builds the
key on success. So a dotted segment fails the whole batch as a visible `PutEventsFailure`, never a
silently-mangled key. Both GitHub producers set dot-free values: webhook → `producer:"github-webhook"`
+ `eventId` from `x-github-delivery` (a UUID); poller → `producer:"github-poller"` + `eventId` from
the notification/activity id; and `toEventId`/`toDotSafe` strips dots/whitespace defensively. The
webhook path also **refuses** an empty delivery id (`github-integration.ts:66`) so `eventId` is never
empty. This is solid.

**`contentHashId` is not circular and not used by any producer in this feature.** It hashes the
caller-supplied identifying content, never the whole event (which contains `eventId`), and grep
confirms no producer calls it — GitHub always supplies an id. It is deterministic (no `Date.now`);
its only stability caveat is that it is a `JSON.stringify` over the caller's object, so a future
local producer must pass a fixed-key-order object (the spec documents this).

**Two real, if latent, weaknesses in the contract — see findings R2-1 (major) and R2-2/R2-3 (minor/nit).**
The headline is R2-1: the README and the `event.ts`/`event-key.ts` docblocks claim **redelivery is
idempotent because the key rebuilds identically, making the webhook dedupe "an optimisation."** That
is true for the *poller* (item-timestamped) but **false for the webhook** — its `timestamp` is
`this.deps.now()` (`new Date().toISOString()`, re-evaluated per delivery), so a redelivery that
bypasses the dedupe store (write succeeded, `dedupe.record` failed → 500 → GitHub redelivers) rebuilds
a **different** key and creates a **duplicate**. For webhooks the dedupe store *is* the thing standing
between you and duplicate history; the doc says the opposite, which is actively dangerous guidance.

### JOB 2 — the re-architecture

Coherent and correct. `reserved_concurrent_executions = 1` **is** set (`github-poller.tf:34`); the
EventBridge rule + target + `aws_lambda_permission` (principal `events.amazonaws.com`, `source_arn`
the rule ARN) are all present; the IAM **role** (not user) is least-privilege — `s3:PutObject` on the
event log, `s3:GetObject`/`PutObject` on the single state key, `s3:ListBucket` on the event bucket
**with no condition** (the R1-7 fix), `ssm:GetParameter` on exactly the two PAT params, and log
writes. `pollOnce` loads the whole state **once** and saves it **once**, threading state through
`reduce` so the two sources run strictly sequentially; the advance-after-write invariant holds
(`source-cycle.ts` `onItems` returns the *unchanged* state on `PutEventsFailure`, so no cursor
advances past an unwritten event; partial-batch writes are idempotent rewrites). With reserved
concurrency 1 and a 30 s timeout inside a 60 s schedule, two invocations cannot overlap, so the single
combined state object cannot suffer the lost update the old concurrent-loop design had — **R1-4 is
genuinely mooted, not merely asserted.** Conditional-request state (`etag`/`lastModified`/`since`)
persists in the state object's `SourceCursor`, and `X-Poll-Interval`/`Retry-After` become a
`notBefore` honoured by `isDue` — the stateless-per-invocation ETag model is correct.

### JOB 3 — R1 audit

Every disposition holds. Spot-confirmed the ones most likely to be overstated:

- **R1-1 (bundle).** The fix is real and the spec genuinely exercises the deployable artifact:
  `bundle.spec.ts` copies `dist/` to a fresh `os.tmpdir()` directory **outside the repo**, spawns a
  clean `node` process with `cwd` there and the env replaced (only `PATH`), and imports the emitted
  `handler.js`. With no `node_modules` reachable, a missing `noExternal` fails on
  `ERR_MODULE_NOT_FOUND` and a missing `createRequire` banner fails on `Dynamic require` — both are
  asserted, for **both** apps. It would fail if the bundle were broken.
- **R1-2 (collision).** Fixed in the contract and pinned by a guard that *can* fail:
  `source-cycle.spec.ts:213` asserts `storedEventKeys(s3)` has length **2** for two same-second
  same-reason mentions (and that both payload ids survive) — an assertion on stored objects, not on
  put count, so it sees the old collapse.
- **R1-3/6/11** — the Events-API immunity claim, the instant characterization, and the secret-repo
  failure-mode docblock are all corrected and (3, 6) now discriminating.
- **R1-5** — `EventBucketName`/`StateBucketName` are real `Schema.brand`s; the wiring guard lives in
  `register.spec.ts`; typecheck (12/12) confirms the brands are threaded end-to-end.
- **R1-7/8/9/10/13/14/15** — ListBucket no-condition; `source_arn = .../*/*`; `SourceAdapter` gone,
  `Normalizer` type in; `matchKey` `encodeURIComponent`-escaped; `putObjects` bounded to
  `putConcurrency`; Docker-only findings resolved with the Dockerfile.

### JOB 4 — honesty & fence

The CLAUDE.md env carve-out is **deleted** and the replacement note is **true**: `.agents/guidance/aws.md`
requires at least `development`/`production`, and both Terraform roots
(`contains(["development","production"])`) and all three app configs
(`deploymentEnvs = {development, production}`, `Schema.Literal(...)`) match exactly — no new false
claim. Three stale references survive the re-arch (findings R2-4/R2-5/R2-6). The `github-poller.tf:3`
mention of "an earlier Railway container" is correct *historical* context, not stale.

### DRY vs WET

The one sharing decision that matters — `event-sink` as the **single** `PutObject` site and the object
key defined **once** in `event-model` — is preserved through the re-arch; `source-cycle.ts` is still
one cycle for both sources. The edge duplication R1 flagged did **not** shrink and slightly grew: the
new `github-poller` config module re-declares `deploymentEnvs`/`logLevels`/`omitUndefined` (now three
copies), the winston factory is in three, and the re-arch added a second near-identical
`testing/run-bundle.ts` (`runNodeIn`) in each Lambda app. This is honestly tracked as `feature.md`
follow-up #4, so it is a recorded debt rather than a hidden one — not a blocker, but the trend is the
wrong way and the env vocabulary is the CLAUDE.md carve-out that exists precisely to stop those values
drifting.

### Verdict

**No blocker. Merge-ready once R2-1's doc claim is corrected** (a false idempotency guarantee in the
load-bearing contract README is the kind of thing the next consumer author will build on). The contract
change is genuinely injective and collision-safe, the re-arch is coherent and correctly single-writer,
Level 0 is intact, and every R1 fix holds or is legitimately mooted. The rest are staleness and a
latent-guidance nit.

### Findings

| # | Severity | Category | Where |
| :-- | :--- | :--- | :--- |
| R2-1 | major | honesty | `packages/event-model/README.md:65-69` (+ `event-key.ts:15-19`, `event.ts:93-99`) |
| R2-2 | minor | correctness | `packages/event-model/src/event.ts:87` |
| R2-3 | nit | correctness | `packages/github/src/dot-safe.ts` / `normalizer.ts:39` |
| R2-4 | minor | honesty | `packages/event-sink/src/s3-event-repository.ts:9` |
| R2-5 | minor | honesty | `turbo.json:38` |
| R2-6 | minor | honesty | `.agents/plans/github-integration/github-notifications-poller.md` § "What WAS verified" |

**R2-1 — the contract README overclaims webhook redelivery idempotence.** README lines 65-69: "the
*same* event redelivered (a GitHub manual redelivery …) rebuilds the *same* key and overwrites itself
with identical bytes — not a duplicate. That is why the webhook handler's dedupe … [is] an
optimisation …, not the thing standing between you and duplicate history: the key scheme is."
The webhook event's `timestamp` is `this.deps.now()` (`register.ts:53` → `new Date().toISOString()`),
re-evaluated on every delivery, and it leads the key. So a redelivery of delivery-id *X* that reaches
`ingest` — which happens when the first delivery's `putEvents` succeeded but `dedupe.record` then
threw (→ handler 500 → GitHub redelivers → `dedupe.seen(X)` is false) — normalizes with a **new**
`receivedAt`, builds a **different** key (same `eventId`, different `{timestamp}`), and writes a
**second** object. The dedupe store, not the key scheme, is what prevents webhook duplicates; the doc
says the reverse and explicitly invites dropping dedupe as "an optimisation." True for the poller
(item-timestamped, genuinely idempotent), false for the webhook. The same over-general claim is in
`event-key.ts:15-19` and `event.ts:93-99`. Fix: scope the idempotency claim to content-timestamped
producers (the poller/local agents) and state plainly that the webhook path's redelivery safety rests
on the dedupe store, because its instant is wall-clock, not content-derived.

**R2-2 — the `producer` docblock recommends `os.hostname()`, which `NoDotString` will reject.**
`event.ts:87`: "a hostname for a local producer (`os.hostname()`)". `os.hostname()` commonly returns a
dotted FQDN (`macbook.local`, `host.corp.example.com`); `producer` is `NoDotString`, so
`encodeEvent` rejects it and **every** write from such a producer fails the batch. Not reachable in
this feature (both GitHub producers use dot-free constants, and `valid-agent-notification.json` models
the safe dash-joined `claude-code-mymachine`), but the contract's own guidance sets a trap for the
next local producer — which is exactly the Claude Code integration this template exists to host. Fix:
tell the caller to dot-sanitize the hostname (or point at `toDotSafe`), and say the constraint out
loud.

**R2-3 — `toEventId`/`toDotSafe` is non-injective, so `eventId`'s collision-prevention silently
depends on provider ids being dot/space-free.** `toDotSafe` maps `a.b`, `a b`, and `a-b` all to
`a-b`. `eventId` is the load-bearing thing that keeps distinct events apart (the R1-2 fix); if a
future provider's ids can contain `.`/whitespace, two distinct items could collapse to one `eventId`
and reintroduce the silent overwrite. Unreachable for GitHub (UUID/numeric ids), so a nit — but worth
a one-line note in the docblock that the guarantee assumes already-distinct-after-sanitisation ids.

**R2-4 — stale "Railway poller" in a shared package docblock.** `s3-event-repository.ts:9` still
describes the second producer as "the Railway poller (AWE-157)"; it is now an EventBridge-scheduled
Lambda. A one-word correction. (Pre-flagged in the brief; confirmed, and it is the only stale
*code*-comment Railway reference — the `github-poller.tf:3` mention is deliberate historical context.)

**R2-5 — stale "Docker image" in `turbo.json`.** The comment at `turbo.json:38` still says the two
apps ship "a Lambda zip **and a Docker image**"; post-rearch both ship a Lambda zip. Cosmetic, but it
is the rationale for a caching rule, so it should read true.

**R2-6 — the poller plan's "What WAS verified" describes the deleted daemon.** The re-arch banner
disclaims superseded content and the `## Deferred verification` **table** was correctly rewritten to
Lambda reality (`aws lambda invoke`, `reserved_concurrent_executions = 1`, EventBridge, IAM role — no
`railway up`). But the "### What WAS verified" prose immediately below still claims the binary was run
"four times", that "both loops … cycle repeatedly … stop promptly on `SIGTERM`", the `unref` defect,
and "**99 specs**" — none of which describe the shipped Lambda (no loops, no SIGTERM, 89 specs). It
reads as present-tense evidence, not disclaimed history. Trim or re-label it so a reader does not take
verification of a binary that no longer exists as current.

---

## R2 fix round — 2026-07-21 (disposition)

Applied by the feature-execution agent. All doc-truth; no behaviour changed (the code was already
correct — the docs over-claimed).

| # | Sev | Disposition |
| :-- | :-- | :--- |
| R2-1 | major | **Fixed.** The idempotence claim is now **scoped to content-timestamped producers**. The webhook `timestamp` is a wall-clock `now()` re-read per delivery and leads the key, so a dedupe-bypassing redelivery writes a *different* key — a duplicate. Corrected in `README.md`, `event-key.ts` and `event.ts` to state plainly that the webhook path's redelivery safety rests on the `X-GitHub-Delivery` dedupe store (which is therefore **not** an optional optimisation), while the poller/local-agent paths are genuinely idempotent because their instant is item-derived. |
| R2-2 | minor | **Fixed.** `event.ts`'s `producer` docblock no longer bare-recommends `os.hostname()` (commonly a dotted FQDN that `NoDotString` rejects); it now points the caller at `toDotSafe` and states the no-dot constraint. |
| R2-3 | nit | **Fixed.** `toEventId`'s docblock now notes `toDotSafe` is non-injective, so `eventId`'s distinctness assumes ids that stay distinct after sanitisation; a provider with dotted ids needs a collision-safe transform (hex/`contentHashId`), not `toDotSafe`. GitHub's ids are unaffected. |
| R2-4 | minor | **Fixed.** `event-sink/src/s3-event-repository.ts` — "the Railway poller (AWE-157)" → "the scheduled poller Lambda (AWE-157)". |
| R2-5 | minor | **Fixed.** `turbo.json` comment "a Lambda zip and a Docker image" → both ship Lambda zips. |
| R2-6 | minor | **Fixed.** AWE-157's `### What WAS verified` prose rewritten to the current Lambda specs (89, not 99) plus the composition-root/bundle specs; the deleted-daemon evidence (loops, SIGTERM, `unref`) is relabelled as **superseded history**, kept only to preserve how the defect was found. |
| DRY | trend | **Recorded, not fixed.** `feature.md` § Follow-up candidates #4 now names all of it — environment vocabulary, winston factory, `capturingLogger`, **`httpStatusOf`** (4 copies, none exported → a genuine follow-up, confirmed not an import), **`run-bundle`** (2 copies) — and recommends a shared `@personal-events/app-support` package as its own story, before the Claude Code integration adds a fourth copy. |

Nothing disputed. Full uncached `build`/`lint`/`test`/`typecheck` green (610 specs); Level 0 intact
(event-model 92, desktop-notifier 92+5); `terraform fmt`/`validate` clean on both roots.
