---
id: AWE-149
title: Monorepo & tooling bootstrap
type: story
status: Pending
parent: ./feature.md
branch: feat/bootstrap-and-iac
project: https://airtable.com/appnae8GXuj1rNVoQ/tblQuFDLYQGrcoiTf/recAmtlL5Goesb0p1
created: 2026-06-28
updated: 2026-06-28
---

# Story: Monorepo & tooling bootstrap

## Definition

### User story
As the developer of the personal-events system
I want a pnpm + turbo monorepo with shared, consistent tooling
So that every package and app I add inherits one build/lint/test setup instead of each
reinventing its own.

### Acceptance criteria
- A pnpm workspace (`pnpm-workspace.yaml`) defines the member globs (e.g. `packages/*`,
  `apps/*`, `infra`).
- `turbo` orchestrates `build`, `lint`, `test`, and `typecheck` tasks across members with
  sensible caching and task dependencies.
- Shared base config is defined once and extended by members: a root `tsconfig` base (ESNext,
  NodeNext, strict, `allowImportingTsExtensions`), a root `biome` config (no semicolons,
  double quotes, width 140 — matching the guidance baseline), and a shared `vitest` setup.
- Root `package.json` declares `"type": "module"` and `"engines": { "node": ">=24" }`; tsup is
  the bundler for buildable packages.
- From a clean checkout, `pnpm install && pnpm build && pnpm lint && pnpm test` all succeed on
  the wired-but-otherwise-empty repo (a trivial placeholder package/test is acceptable to make
  the pipeline real).
- `.gitignore` covers `node_modules`, `dist`, `.turbo`, and Terraform/local-state artifacts.
- **Failure modes:** running a task in a member that lacks that script does not fail the whole
  graph spuriously; a wrong Node version surfaces a clear `engines` warning.

### Notes / Open questions
- Package manager is pnpm and build orchestrator is turbo per the user decision and
  `.agents/languages/typescript/typescript-tools.md`.
- Proposed npm scope: `@personal-events/*`. Confirm during `/plan-story` if a different scope
  is wanted.
- Decide the exact workspace layout (`packages/` vs `apps/` vs top-level `infra/`) when
  planning; `infra/` (Terraform) is a member but sits outside the TS build graph and is wired
  via a wrapper script.
- Whether to add a CI workflow now or defer is open — feature scopes CI out for now.

## Plan

> Validate documentation, codebase patterns, and task sanity before implementing. This is a
> greenfield repo: the **authoritative exemplars are the agent guidance and the
> `.agents/code-examples/typescript/` baseline** (already pinned to the conventions below).
> Mirror them; do not invent a divergent tool config.

### Decisions resolved during planning (confirm before coding)
- **npm scope:** `@personal-events/*` (root private package can be `personal-events` or
  `@personal-events/root`).
- **`.ts` import extensions vs tsup — RECOMMENDED CHANGE:** the guidance
  (`.agents/languages/typescript/typescript.md`) mandates `.ts` extensions in relative imports
  with `allowImportingTsExtensions: true`. That flag **requires `noEmit`/`emitDeclarationOnly`
  and breaks tsup's JS emit.** Use **`rewriteRelativeImportExtensions: true`** (TS ≥5.7)
  in the base config instead: it preserves the "write `./foo.ts`" convention *and* rewrites to
  `./foo.js` on emit, so tsup builds work. `allowImportingTsExtensions` may still be set in the
  `typecheck`-only path, but the buildable base config uses `rewriteRelativeImportExtensions`.
  **This is a deviation from the literal guidance — flagged for the user.**
- **Workspace layout:** `packages/*` (libraries, e.g. `event-model`), `apps/*` (runnable apps,
  e.g. `desktop-notifier`), and top-level `infra/` (Terraform, with a stub `package.json` so it
  joins the turbo graph). `pnpm-workspace.yaml` lists `packages/*`, `apps/*`, `infra`.
- **CI:** out of scope for this story (feature defers it); the turbo scripts are the dev loop.

### Architectural constraints — VERIFY BEFORE WRITING ANY TASK
<!-- From .agents/general.md, typescript.md, typescript-tools.md, node/preferences.md. -->
- **TS house style** (`typescript.md`): no trailing semicolons, double quotes, arrow
  functions by default, no enums (`as const` objects), no accumulator loops, `Record` lookups
  over `if/else` chains. These are enforced by biome — the config must encode them.
- **Tooling** (`typescript-tools.md`, `node/preferences.md`): pnpm, turbo, tsup, biome,
  vitest, Node ≥24, ESM, winston for logging, effect as the default lib. This story only
  *wires* these; it does not write domain code.
- **Separation of concerns** (`general.md`): shared config lives once at the root and is
  `extends`-ed; members own only their deviations. No config duplication across members.
- This is pure scaffolding — no Gather/Compute/Persist domain logic, no CQRS surface yet.

### Files to read — READ THESE BEFORE IMPLEMENTING
- `.agents/code-examples/typescript/package.json` — Why: the canonical dependency set and
  versions (tsup, biome ^2, vitest ^4, typescript ^6, @types/node) and `"type": "module"` +
  `engines` + `pnpm.onlyBuiltDependencies` shape to mirror.
- `.agents/code-examples/typescript/tsconfig.json` — Why: the exact compiler-option baseline
  (ESNext/NodeNext/strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes) to lift into
  `tsconfig.base.json` (applying the `rewriteRelativeImportExtensions` change above).
- `.agents/code-examples/typescript/biome.json` — Why: the authoritative biome config
  (semicolons asNeeded, double quotes, lineWidth 140, recommended rules, noExplicitAny error,
  organizeImports). Copy as the root `biome.json`, widening `files.includes` for the workspace.
- `.agents/code-examples/typescript/tsup.config.ts` and `vitest.config.ts` — Why: reference
  shapes for per-package build/test config.
- `.agents/languages/typescript/typescript-tools.md` — Why: pnpm + vitest mandate.

### Files to create / change
- `package.json` (root) — private, `"type": "module"`, `"engines": { "node": ">=24" }`,
  `"packageManager": "pnpm@<pinned>"`, dev-deps `turbo` + `typescript` + `@biomejs/biome`,
  scripts that delegate to `turbo run build|lint|test|typecheck`.
- `pnpm-workspace.yaml` — members `packages/*`, `apps/*`, `infra`; a `catalog:` of shared
  versions (typescript, @types/node, tsup, vitest, biome) with `catalogMode: strict`.
- `turbo.json` — turbo 2.x **`tasks`** schema (NOT `pipeline`): `build` (`dependsOn: ["^build"]`,
  `outputs: ["dist/**"]`), `typecheck` (parallel, `dependsOn: []`), `lint`, `test`
  (`dependsOn: ["^build"]`, `outputs: ["coverage/**"]`); placeholder `plan`/`deploy`
  (`cache:false`, `passThroughEnv` for AWS) for the future `infra` member.
- `tsconfig.base.json` (root) — the shared compiler options; members `extends` it.
- `tsconfig.json` (root) — references/solution file or a thin `extends` for editor use.
- `biome.json` (root) — copied from the exemplar, `files.includes` widened to
  `packages/**`/`apps/**` and excluding `infra/**`, `dist/**`, `node_modules/**`.
- `vitest.config.ts` (root) — `test.projects: ["packages/*", "apps/*"]` (NOT the deprecated
  `vitest.workspace.ts`); root-only coverage (v8).
- `.gitignore` — `node_modules/`, `dist/`, `.turbo/`, `coverage/`, `.terraform/`,
  `*.tfstate*`, `.terraform.lock.hcl` is **kept** (committed).
- `.nvmrc` / `.node-version` — `24`.
- `packages/_placeholder/` (or fold into the real `event-model` package later) — a minimal
  package with `src/index.ts`, a passing `*.spec.ts`, its own `tsconfig.json` (extends base),
  `tsup.config.ts`, and `package.json`, **solely to make `build`/`test` real and green**. Note
  in the PR that AWE-150 replaces/augments this with the actual event-model package.

### Relevant documentation
- [Turborepo `turbo.json` reference](https://turborepo.dev/docs/reference/configuration) — Why:
  the 2.x `tasks` schema, `dependsOn` (`^` topological vs same-pkg), `outputs`, `cache`.
- [Turborepo multi-language](https://turborepo.dev/docs/guides/multi-language) — Why: how the
  Terraform `infra` member joins the graph via a stub `package.json`.
- [pnpm catalogs](https://pnpm.io/catalogs) and [`pnpm-workspace.yaml`](https://pnpm.io/pnpm-workspace_yaml)
  — Why: centralized version catalog; note pnpm 11 moved settings out of `.npmrc`.
- [Biome big-projects/monorepo](https://biomejs.dev/guides/big-projects/) and
  [upgrade-to-v2](https://biomejs.dev/guides/upgrade-to-biome-v2/) — Why: single root config,
  `includes` (not `include`/`ignore`), config-relative globs, `extends: "//"`.
- [Vitest Test Projects](https://vitest.dev/guide/projects) — Why: `test.projects` replaces the
  deprecated workspace file; coverage/reporters are root-only.
- [`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)
  and [`allowImportingTsExtensions`](https://www.typescriptlang.org/tsconfig/allowImportingTsExtensions.html)
  — Why: the noEmit constraint and the tsup-compatible alternative.

### Patterns to follow
- **Versions (pin at install, mirror the exemplar's majors):** `turbo@^2.10`, `pnpm@^11`,
  `typescript@^6.0`, `tsup@^8.5`, `@biomejs/biome@^2.5`, `vitest@^4.1`, `@types/node@^24`
  (match the Node 24 runtime major, NOT the newest @types/node).
- **tsconfig base** must include `isolatedModules: true` and `verbatimModuleSyntax: true`
  (required for esbuild/tsup per-file transpile) alongside the exemplar's strict flags.
- **Biome v2 gotchas:** globs are relative to the config file and `*` no longer crosses `/`;
  use `includes` with `!` negations; run `biome migrate` only if porting an old config.

### Codebase irregularities to ignore
- The exemplar `.agents/code-examples/typescript/tsconfig.json` sets
  `allowImportingTsExtensions: true` with `noEmit: true` — correct **for a typecheck-only
  example**, but do NOT copy that flag into the buildable `tsconfig.base.json`; use
  `rewriteRelativeImportExtensions` instead (see decisions above).
- The exemplar is a single package; this story generalizes its config to a workspace — expect
  to widen `files.includes` and add `pnpm-workspace.yaml`/`turbo.json` which the exemplar lacks.

### Step-by-step tasks
Execute in order. Each is independently validatable.

#### CREATE root workspace manifests
- **IMPLEMENT**: root `package.json` (private, ESM, engines ≥24, packageManager pinned, turbo
  scripts), `pnpm-workspace.yaml` (members + catalog), `.nvmrc` (24), `.gitignore`.
- **PATTERN**: deps/versions from `.agents/code-examples/typescript/package.json`.
- **GOTCHA**: `.terraform.lock.hcl` is committed; `.terraform/` and `*.tfstate*` are ignored.
- **VALIDATE**: `pnpm install` (succeeds, writes `pnpm-lock.yaml`).

#### CREATE shared tsconfig + biome + vitest + turbo config
- **IMPLEMENT**: `tsconfig.base.json`, root `tsconfig.json`, `biome.json`, `vitest.config.ts`,
  `turbo.json` per the files list above.
- **PATTERN**: `biome.json` ← exemplar; compiler options ← exemplar tsconfig with the
  `rewriteRelativeImportExtensions` substitution.
- **GOTCHA**: turbo 2.x uses `tasks`, not `pipeline`; vitest uses `test.projects`, not a
  workspace file.
- **VALIDATE**: `pnpm biome check .` (config parses, no errors on empty tree); `pnpm turbo run build --dry` (graph resolves).

#### CREATE placeholder package to make the pipeline real
- **IMPLEMENT**: `packages/_placeholder` with `package.json` (scope `@personal-events/`,
  `type: module`, build=tsup, test=vitest, typecheck=tsc --noEmit), `tsconfig.json`
  (extends base, composite), `tsup.config.ts` (esm, dts, target node24), `src/index.ts`
  exporting a trivial function, and `src/index.spec.ts` asserting it.
- **PATTERN**: `tsup.config.ts` / `vitest.config.ts` from the exemplar.
- **GOTCHA**: per-package `vitest.config.ts` uses `defineProject` with a unique `name`.
- **VALIDATE**: `pnpm build && pnpm test && pnpm lint && pnpm typecheck` (all green).

#### VERIFY guidance conformance (tooling encodes general.md)
- **IMPLEMENT**: Confirm the shared config actively *enforces* `.agents/general.md` + the TS
  guidance so every later story inherits it for free: biome covers no-semicolons / double-quotes
  / width-140, `noExplicitAny: error`, `organizeImports`; the base tsconfig keeps `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Enable any biome rule that maps to
  the guidance (no-accumulator-loop / no-enum / Record-lookup where a rule exists) and document
  the rest in a short `CONTRIBUTING.md`/`CLAUDE.md` note. Refactor the placeholder package so it
  is itself a clean exemplar of the guidance (pure arrow fns, explicit return types) rather than
  generic boilerplate.
- **VALIDATE**: `pnpm biome check .` clean; the placeholder package passes the exact bar later
  stories will be held to.

### Testing strategy
- **Unit**: the placeholder package ships one real passing vitest spec so `turbo run test`
  exercises the whole pipeline (not a no-op). Per `.agents/tests.md`, prefer real logic over
  mocks — a pure function + assertion is sufficient here.
- **Integration**: n/a (no I/O in this story).
- **Edge cases**: confirm `turbo run <task>` does not fail for members lacking that script;
  confirm a clean checkout (`rm -rf node_modules .turbo dist` then reinstall) is reproducible.

### Validation commands
- Level 1 — Syntax & style: `pnpm biome check .`
- Level 2 — Types: `pnpm turbo run typecheck`
- Level 3 — Build & unit: `pnpm turbo run build && pnpm turbo run test`
- Level 4 — Manual: from a clean clone, `pnpm install && pnpm build && pnpm lint && pnpm test`
  all succeed; `pnpm turbo run build` a second time reports cache hits.
