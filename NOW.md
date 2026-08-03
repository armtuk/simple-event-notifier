# NOW — development log

Append-only log of AI actions on this repo, per `.agents/guidance/now.md`. Newest entries at the
bottom.

---

## 2026-08-03 — Architecture pinned and plan tree restructured

### Requested

A major replan. The existing feature/story structure "just kinda doesn't work with the realistic
way to implement." Break the build into new steps, starting with the absolute minimum: Terraform
for the S3 bucket and project/environment DNS, the TypeScript event schema, TypeScript + a thin
bash wrapper to push events to the bucket, and everything else (VPC, Lambda, cert, API Gateway,
webhook DNS) moved to a future-state area. Then a local sync client, then macOS notifications, then
Claude Code, then GitHub. Separately: record the layered architecture that any system with an
internal model plus 3P integrations must follow, and make Effect the default for schema, code
structure and async.

### Understood as

Two architectural decisions to pin durably *before* any plan depends on them, then a full
restructure of `.agents/plans/` from five features to five differently-scoped ones, reusing ticket
numbers where scope survives and abandoning what does not.

### Actions completed

**Architecture (2 accepted ADRs, README index created, glossary synced):**
- `2026-08-03-0028-layered-architecture` — Application Model; a Repository in front of every
  external system (a 3P API is a store like any other); Transformers as the only code permitted to
  know a foreign shape; Business Logic Services transiting Application Model values only;
  Controllers restricted to protocol concerns; one functional area per 3P integration. Records the
  optional layers deliberately omitted (Aggregate Service, DataService, projections) and fixes the
  system at CQRS maturity Level 2–3.
- `2026-08-03-0035-effect-as-default-idiom` — `effect/Schema` only (no Zod); `Context.Tag` + `Layer`
  as the DI mechanism; `Effect<A, E, R>` for anything effectful; raw `Promise` only at process
  entry points via `Effect.runPromise`. `Either`/`Option` retained for pure code.
- Created `CLAUDE.md` (repo had none) restating both as binding, plus stack defaults, the event
  model's published-contract status, and the repo's non-standard Airtable topology.

**Plan restructure — 5 features, 20 stories:**
- `minimal-event-pipeline` (F1, new) — absorbs the whole of `bootstrap-and-iac` and
  `event-push-cli`, plus AWE-153 relocated out of `github-integration`. Seven stories.
- `local-sync-client` (F2, new) and `macos-notifications` (F3, new) — the former
  `desktop-notifier-daemon` story split along the poll/emit seam, plus three new stories.
- `claude-code-integration` (F4) and `github-integration` (F5) — feature files rewritten;
  `depends-on` corrected to `[minimal-event-pipeline]`, removing the knot that had Claude Code
  transitively blocked behind all of GitHub.
- Four new tickets: AWE-215 (Terraform quarantine), AWE-216 (stdout emitter/sink), AWE-217 (notifier
  adapter), AWE-218 (notification wiring/filtering).
- Abandoned with recorded reasons: AWE-157 (poller — user owns the target repos, so the no-admin
  fallback is unnecessary) and AWE-160 (absorbed into AWE-213).
- Story files moved with `git mv` to preserve history; the two dissolved `feature.md` files removed
  (recoverable from git history, and F1 records what it supersedes).
- Every plan file migrated to the new status vocabulary (`ready` / `todo:backlog` /
  `todo:abandoned`); `system.md` functional-area catalogue rewritten.
- Airtable synced: 4 records created, 16 updated; Backlog Order 150–169 now matches build order.

**Effect conversion (partial, deliberate):** AWE-162 and AWE-156 converted from `Promise` to
`Effect` because their plans survive the restructure intact. The other four files carrying `Promise`
signatures were left alone — they are abandoned or slated for rewrite, so converting them would be
discarded work.

### Open questions / blockers

- **Most deep plans are now stale.** Only AWE-149 and AWE-150 remain `ready`. AWE-151, 152, 153,
  154, 155, 156, 161 and 162 are `todo:backlog` and carry `## Plan` sections written against the old
  structure; each needs a `/plan-story` re-run before execution. Each file states this inline.
- **Uncommitted Terraform in the working tree** — `infra/modules/{dns,main,network,vpc}.tf` staged
  and `{iam,lambda}.tf` plus `environments/development/variables.tf` modified, authored outside this
  work. AWE-215 will reorganize these; coordinate before executing it.
- **No environment beyond `development` exists** in `infra/environments/`; AWE-151 must add
  `production` per `aws.md`.
- **Logging library unresolved.** Several plans specify winston, which `node/preferences.md` ties to
  the *not-using-effect* branch. Under the Effect ADR this should probably be Effect's logging;
  not yet decided.

### Next steps

1. Commit the restructure (nothing has been committed).
2. `/plan-story .agents/plans/minimal-event-pipeline/monorepo-bootstrap.md` — AWE-149 is `ready` and
   is the only story with no prerequisites.
3. Re-plan AWE-153 and AWE-151 before the F1 chain reaches them.

### Where work left off

Plan tree, ADRs, README index, glossary, `CLAUDE.md` and Airtable are all consistent. No source code
or Terraform was written or modified in this session — the restructure is planning artifacts only.
