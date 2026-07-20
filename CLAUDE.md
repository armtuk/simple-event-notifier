# AWS Work Eventer — project guidance

The shared engineering constitution lives in `.agents/general.md` and the language/framework
guidance under `.agents/`. This file records only what is **specific to this repo**.

## Workspace layout

| Path | Holds |
| :--- | :--- |
| `packages/*` | Libraries (e.g. `@personal-events/event-model`) |
| `apps/*` | Runnable apps/daemons (e.g. `@personal-events/desktop-notifier`) |
| `infra/` | Terraform (HCL). Joins the turbo graph via a stub `package.json`; sits outside the TS build graph and is excluded from `biome`. |

Package manager is **pnpm** (workspace + a strict `catalog:` for shared versions in
`pnpm-workspace.yaml` — add a new shared dep to the catalog, not to each member). Task
orchestration is **turbo** (`turbo.json` uses the 2.x `tasks` schema). Bundler is **tsup**,
test runner is **vitest** (root `vitest.config.ts` uses `test.projects`, not the deprecated
workspace file), linter/formatter is **biome**.

Root commands: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm typecheck`.

**Prerequisites:** Node ≥ 24, pnpm, and the **Terraform CLI** (≥ 1.11). Terraform is required for
`pnpm lint` and `pnpm typecheck`-adjacent infra tasks because the `infra` workspace member's `lint`
is `terraform fmt -check -recursive .` — without the binary those tasks fail on a missing command,
not on a lint error. This is a project whose whole substrate is Terraform, so the tool is assumed
rather than made optional.

## TypeScript conventions this repo pins

- **Node ≥ 24**, ESM only (`"type": "module"`).
- **Relative imports carry the `.ts` extension** (`from "./event-key.ts"`). This is enabled by
  `rewriteRelativeImportExtensions: true` in `tsconfig.base.json`, **not**
  `allowImportingTsExtensions` — the latter forces `noEmit`/`emitDeclarationOnly` and breaks
  tsup's JS emit. `.agents/languages/typescript/typescript.md` names
  `allowImportingTsExtensions`; this substitution is a deliberate, equivalent-behaviour
  deviation so the same source convention works under a bundler.
- Per-package `tsconfig.json` is `noEmit: true` — **tsc is the type checker only**; tsup owns
  emit (JS + `.d.ts`).

## Rules biome cannot enforce — hold these in review

Biome covers no-semicolons, double quotes, width 140, `noExplicitAny`, `noEnum`,
`organizeImports`, and the base tsconfig keeps `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`. The following have no lint rule and are review responsibilities:

- **No accumulator loops.** A loop filling a previously declared mutable accumulator is banned
  in every form, including `.forEach` closing over one. See
  `.agents/code-examples/typescript/src/looping.ts`.
- **Gather / Compute / Persist separation**, and **slice-don't-dump** for function parameters.
- **Module-level SRP** — one axis of change per file.
- **Result types** — return `Either`/tagged unions, never bare `null`/`undefined`.
- **`Record<K, T>` lookups** instead of `if`/`else if` chains keyed on one discriminator.
- **Arrow functions** by default; `async` on every promise-returning function.
- **A long-running loop must not chain each iteration's promise to the next.** Returning a recursive
  call from an `async` function makes the first promise unable to settle until the last one does, so
  pending promises accumulate for the life of the process. Schedule the next iteration from a timer
  callback and discard the previous promise — see `apps/desktop-notifier/src/daemon.ts` → `runDaemon`.
  The cost of getting this wrong is small per tick but never stops: the closed-over state *is*
  collected (the recursive call is in tail position, so fattening each tick's state moves the leak by
  zero), but the chain of pending promise objects, their reaction records and their resolving
  closures is not — **measured at ~97 bytes/tick, linear and unbounded** (2 390 KB over 25 000 ticks,
  9 421 KB over 100 000, 37 546 KB over 400 000). At the daemon's 30 s default that is ~280 KB/day,
  ~8 MB/month, for the life of the process. Cheaper than "one async frame per tick", but not free.
  This is here rather than in a spec because it is **not testable cheaply**: async stack depth is not
  a discriminator at all (V8's zero-cost async traces do not chain across the recursive `await`), and
  the heap signal, while real, needs `--expose-gc` and ~10⁵ ticks to clear the noise floor — a
  classic flaky spec. It is a review responsibility.

## The two-bucket rule — operational state NEVER goes in the event bucket

The event bucket holds events and nothing else. Delivery-dedupe markers, poller cursors, and any
future operational state live in the **separate** `state.{env}.{system}.{domain}` bucket
(`infra/personal-events/state-bucket.tf`).

This is a correctness requirement, not organisation. `apps/desktop-notifier/src/poller.ts` lists the
event bucket with `ListObjectsV2` `StartAfter` and **no prefix filter**, then advances its high-water
mark to the highest key it saw. Event keys lead with a year — `2026-…` — while `deliveries/…` and
`state/…` start with a letter, which sorts **above** every digit. A single non-event object in the
event bucket would push a consumer's mark above every event key that will ever exist, and that
consumer would **silently never receive another event**, with no error anywhere.

Both `github-integration` story plans originally specified a prefix inside the event bucket; the
separate bucket is the fix. Do not "simplify" it back.

## Documented carve-outs from the shared guidance

Deviations recorded here so they are deliberate and bounded rather than eroding silently. Anything
not on this list follows `.agents/` as written.

- **Early-return guard clauses are exempt from "always use if AND else."**
  `.agents/languages/typescript/typescript.md` states the no-fall-through rule unconditionally, but
  a guard that `return`s (a rejected config, an already-aborted signal, an unreachable bucket) reads
  worse forced into an `else`, and the rule's real target is *branch selection* on one discriminator
  — which must still use a `Record` lookup. A guard clause selects nothing; it exits. This exemption
  covers guards that return or throw immediately, nothing more.
- **The project has one environment vocabulary: `local`, `dev`, `qa`, `staging`, `prod`** —
  `.agents/guidance/aws.md`'s list. It is used verbatim on both sides: the Terraform `env` variable
  (both roots) validates against it, and the daemon's `ENV` is a `Schema.Literal` over the same five.
  It differs from `.agents/guidance/logging.md`'s `["dev","qa","stage","prod"]` in two ways, and this
  single sentence is the reason for both:
  - **`local` is included.** The desktop notifier's ordinary home is a laptop; refusing the project's
    own default environment would make it unusable out of the box.
  - **The third environment is spelled `staging`, not `stage`.** One spelling has to win, because the
    same value names S3 buckets and DNS labels on the Terraform side and stamps log records on the
    TypeScript side — two spellings for one concept is the actual defect. `aws.md`'s spelling wins
    because its values become durable, externally-visible resource names.

  These are explicit literals, never fallbacks: an unrecognized `ENV` fails startup, which is the
  harm `logging.md`'s closed set exists to prevent. `infra/*/variables.tf` and
  `apps/desktop-notifier/src/config.ts` both point back here.
- **`rewriteRelativeImportExtensions` replaces `allowImportingTsExtensions`** — see the TypeScript
  section above.
