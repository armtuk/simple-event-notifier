# NOW — development log

Append-only log of AI work sessions, per `.agents/guidance/now.md`. Newest entry at the bottom.

> **Back-dated preamble.** This file should have existed from the first session. It did not: the
> `Development logging` row of `.agents/general.md`'s trigger table was missed during the
> `bootstrap-and-iac` execution, and the R1 review missed it too — it was caught by R2 (finding
> R2-8). The three entries below are reconstructed from the commits, the plan files, and the review
> record rather than written live, and are marked as such. Everything after them is written in
> session.

---

## 2026-07-19 — START — `bootstrap-and-iac` feature execution *(reconstructed)*

**Prompt (summarised):** execute the four `bootstrap-and-iac` stories in dependency order —
AWE-149 monorepo bootstrap, AWE-150 event-model package, AWE-151 S3 + Route53 Terraform,
AWE-152 desktop-notifier daemon — in the `aws-work-eventer-wt-bootstrap-and-iac` worktree on
`feat/bootstrap-and-iac`. Code and dry-run only: no `terraform apply`, no AWS resource creation, no
NS records in the live `fifthdimensionengineering.com` zone, no publish/deploy/push.

**Understood as:** refresh four already-deep-planned stories against the current repo, implement
them in order, maintain plan status per `planning-artifacts.md`, and record honestly anything the
side-effect fence left unverified.

## 2026-07-19 — END — `bootstrap-and-iac` feature execution *(reconstructed)*

**Actions completed**

- **AWE-149 → Completed.** pnpm + turbo workspace, shared `tsconfig.base.json` / `biome.json` /
  root `vitest.config.ts`, tsup, Node ≥24 ESM, `CLAUDE.md` recording what biome cannot enforce.
- **AWE-150 → Completed.** `@personal-events/event-model`: Effect Schema event shape, the
  `{timestamp}.{type}.p{priority}.{source}.{name}.json` codec, tagged `EventModelError`, exemplars.
- **AWE-151 → Implementation Adjustment.** Terraform for the event bucket and the delegated Route53
  zone, two root modules, native S3 state locking, ADR `2026-07-19-1900-iac-foundation`.
- **AWE-152 → Implementation Adjustment.** The polling daemon: Gather/Compute/Persist split across
  `poller` → `classify`/`notification-content` → `notify`/`state`.

**Open questions / blockers:** none blocking. The side-effect fence left every `terraform apply`
criterion and the real-bucket E2E unverified; each is enumerated in the two stories'
`## Deferred verification` sections with the command that closes it.

**Next steps:** independent code review, then the deferred verifications once the user is ready to
apply.

**Context summary:** feature stays `Implementing` because AWE-151 and AWE-152 are non-terminal by
design under the fence. `.agents/cache/effect/**` does not exist in this repo, so the Effect API was
verified against installed typings; `/update-effect-docs` recommended before the next Effect story.

**Left off at:** four commits on `feat/bootstrap-and-iac`, validation green, nothing pushed.

---

## 2026-07-19 — START — R1 review fix round *(reconstructed)*

**Prompt (summarised):** apply the R1 code review (1 blocker, 6 major, 8 minor, 3 nits) recorded in
`.agents/plans/bootstrap-and-iac/claude-automated-code-review.md`. Tier 1 = blocker + majors,
Tier 2 = a named list of minors/nits, Tier 3 = record as follow-ups rather than implement. Correct
any plan-file claim that is untrue. Same fence, same branch.

**Understood as:** fix the defects, but treat the false claims in the audit trail as first-class
defects too, and re-audit my own `## Deferred verification` sections for overclaiming.

## 2026-07-19 — END — R1 review fix round *(reconstructed)*

**Actions completed**

- **#1 BLOCKER — silent event loss.** `isoInstantPattern` allowed a variable-width millisecond
  fraction, so object keys did not sort chronologically (`.` sorts below every digit, `Z` above), and
  a consumer's `StartAfter` high-water mark skipped earlier events permanently. Pinned to exactly
  three fractional digits, mirrored in `eventKeyPattern`, with ordering specs.
- **#3, #5, #10** — `eventType` failure message; `Schema.URL` → byte-stable `WorkItemUrl`; codec made
  injective (`p05` rejected). **#7, #9** — exemplars and `describeCause` de-duplicated.
- **#2, #4, #6, #13, #14** — daemon: bounded poll loop, bucket pre-flight, asserted log lines, closed
  config value sets, `Delivery` slice.
- **#8, #16** — Terraform: shared `hardened-bucket` module; honest `validate` scripts.
- **#11, #12, #15, #20** recorded under `feature.md` § Follow-up candidates instead of implemented.
- Corrected four untrue claims in the audit trail (#3, #6, #16, #18).

**@test-removed** — `event-key.spec.ts` → *"recovers a millisecond-less timestamp"*. Rationale: the
spec pinned as *supported* exactly the variable-precision timestamp that finding #1 proved causes
permanent event loss. Keeping it would have asserted the defect. Replaced by ordering specs and by
rejection rows for every non-three-digit fraction. Recorded in `event-model-package.md` § R1 fixes.

**Open questions / blockers:** #12 (a valid event whose notification fails is skipped permanently —
at-most-once vs retry vs quarantine) needs a product decision from the user, not an engineering one.

**Next steps:** R2 review.

**Left off at:** four further commits, 173 specs green uncached, tree clean.

---

## 2026-07-19 — START — R2 review fix round

**Prompt (summarised):** apply the R2 review (0 blockers, 1 major, 7 minor, 4 nits). R2-1 is
documentation-and-record only — correct `poller.ts`'s docblock and add follow-up rows; do **not**
implement the lookback window, which carries the same product decision as #12. Fix R2-2 through
R2-12. R2-6 supersedes the `local` carve-out: pick one environment spelling and apply it in both
halves. Create the missing `NOW.md`. Confirm the R2-2 cache fix by actually invalidating the cache.

**Understood as:** close the residual half of the blocker's invariant *in the record* rather than in
code, fix the cache hole that silently re-enabled contract drift, and make the environment
vocabulary single-valued across Terraform and TypeScript.

## 2026-07-19 — END — R2 review fix round

**Actions completed**

- **R2-1 (major) — recorded, not fixed, as instructed.** Rewrote `poller.ts`'s module docblock, which
  asserted the opposite of the truth on both counts: `StartAfter` returns objects whose *key* sorts
  above the mark (not objects *written* since), and the `LastModified` rationale was inverted
  (`LastModified` is S3's single server clock and is the skew-*immune* option). Added a
  characterization spec pinning both loss routes and two rows to `feature.md` § Follow-up candidates.
- **R2-2 (minor) — the cache hole.** `build.inputs` omitted `exemplars/**`, so editing a canonical
  exemplar invalidated nothing and the consumer replayed a cached PASS — reintroducing the very drift
  the shared-exemplar change existed to prevent. Reproduced it, fixed it, and verified the fix by
  drifting an exemplar and watching the consumer suite genuinely re-run and fail.
- **R2-3** third `BucketProbeInconclusive` outcome so a laptop starting before wifi retries instead
  of exiting. **R2-5** validation blocks on the module contract, `env` validation lifted into
  `bootstrap`. **R2-6** one project environment vocabulary (`aws.md`'s spelling) on both sides.
  **R2-7** an unusable state file now logs at `warn`. **R2-9** the fall-through `if`. **R2-10**,
  **R2-11**, **R2-12** record corrections.
- **R2-4** — measured both discriminators R2 proposed and neither works (async stack depth does not
  grow across the recursive `await`; heap retention does not diverge because the call is in tail
  position). Took R2's alternative: renamed the spec to what it actually tests and moved the
  non-chaining shape to `CLAUDE.md` as a review responsibility.

**Open questions / blockers:** unchanged — #12 and now R2-1 both await the same product decision
about delivery semantics (at-most-once vs retry vs quarantine, and how wide a lookback window).

**Next steps:** user ruling on the `local`/`staging` environment vocabulary (flagged by the
coordinator) and on delivery semantics; then the deferred `terraform apply` verifications.

**Context summary:** no code change in this round touched the fence — still no `terraform apply`, no
AWS resource, no NS record in the live zone.

**Left off at:** validation green uncached; tree clean on `feat/bootstrap-and-iac`.

---

## 2026-07-19 — START — `github-integration` feature execution

**Prompt (summarised):** execute the five `github-integration` stories in dependency order —
AWE-153 `integration-core`, AWE-154 `packages/github`, AWE-155 the generic webhook ingest,
AWE-156 the GitHub webhook handler, AWE-157 the Railway poller — in the
`aws-work-eventer-wt-github-integration` worktree on `github-integration`. Refresh each plan against
the real repo before executing it (they were planned against an **empty** one). Code and dry-run
only: no `terraform apply`, no AWS resource, no webhook registered against a real repository, no
live GitHub API call with a real PAT, no Railway deployment, no push. Do **not** fix the known
producer-timestamp ordering hazard — record any new instance of it for the user instead.

**Understood as:** build the reusable template first and get its shape right, since Claude Code is
the next integration to plug into it; treat every story plan as a proposal to be checked against the
code rather than a specification to be typed in; and be explicit and honest about the large fraction
of this feature that the side-effect fence leaves untested.

## 2026-07-19 — END — `github-integration` feature execution

**Actions completed**

- **AWE-153 → Completed.** `@personal-events/integration-core`: the mapping-config schema, the
  `channel`-discriminated trigger and its canonical `matchKey`, compile-then-lookup classification,
  the pure `transform`, and interfaces-only `SourceAdapter`/`SecondaryProcessor`. ADR
  `2026-07-19-2130-integration-template-and-dual-path` covers the whole feature.
- **AWE-154 → Implementation Adjustment.** `@personal-events/github`: subset payload schemas, the
  non-confusable trigger union (now actually *enforced* against the config), the mapping JSON, and
  pure normalizers for the webhook and notification channels.
- **AWE-155 → Implementation Adjustment.** `@personal-events/event-sink` (the single S3 write path)
  plus `apps/webhook-ingest` and its Terraform: HTTP API, Lambda, ACM certificate, `hooks.` record.
- **AWE-156 → Implementation Adjustment.** The GitHub webhook edge: HMAC over the raw body, S3
  delivery-marker dedupe, SSM SecureString secret, and the operator setup runbook.
- **AWE-157 → Implementation Adjustment.** `apps/github-poller`: dual-source conditional polling,
  bounded per-source dedupe, S3-persisted cursors, per-source isolation, Dockerfile + Railway config.

**Three defects found and fixed that the plans would have introduced**

1. **Operational state in the event bucket (AWE-156 and AWE-157).** `deliveries/…` and `state/…`
   both sort above every `2026-…` event key, and `apps/desktop-notifier/src/poller.ts` lists the
   bucket with no prefix filter and advances its mark to the highest key seen — so one marker would
   have stranded the notifier past every event that will ever exist, silently and permanently. Fixed
   with a separate operational-state bucket; the rule is now in `CLAUDE.md`.
2. **The poller exited after one cycle per source.** Its scheduler used `setTimeout(...).unref()`,
   and between polls that timer is the only handle a healthy poller holds. Found by running the built
   binary; no unit spec could have caught it, because every spec injects its own scheduler.
3. **Notification triggers over-specified (AWE-154).** Including `subject.type` meant every
   notification rule silently fell through to the config default. Caught by the specs.

**@test-removed** — none. No spec was deleted or skipped in this feature.

**Open questions / blockers:** none blocking. The delivery-semantics question is now **three-way**:
`bootstrap-and-iac`'s #12 and R2-1, plus this feature's notifications timestamp collapse
(`updated_at` is second-precision, so same-instant siblings are the *norm* for that producer, not a
coincidence). One ruling — at-most-once vs retry-until-delivered vs quarantine-and-continue, and how
wide a lookback — closes all three. Recorded in `feature.md` § Follow-up candidates, in the ADR, and
in `packages/github/src/instant.ts`; deliberately **not** fixed.

**Next steps:** independent code review, then the deferred verifications — they are the only route to
`Completed` for AWE-154 through AWE-157, and they need the user's AWS account, a webhook secret, a
classic PAT, and a Railway project.

**Context summary:** `.agents/cache/effect/**` still does not exist, so every Effect call was
verified against `node_modules/effect` typings. Five new workspace members joined the turbo
graph (`integration-core`, `github`, `event-sink`, `webhook-ingest`, `github-poller`); `turbo.json`'s `plan`/`deploy` tasks gained `dependsOn: ["^build"]` because
`archive_file` reads the Lambda bundle at **plan** time, not only apply.

**Left off at:** five commits on `github-integration`; `pnpm build/lint/test/typecheck --force` green
uncached with 602 specs (Level 0's 182 among them, unchanged); `terraform fmt -check` clean,
`validate` Success on both roots, and a real scratch `plan` of `34 to add, 0 to change, 0 to destroy`.
Nothing applied, nothing deployed, nothing pushed.
