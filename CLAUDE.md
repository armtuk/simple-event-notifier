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
