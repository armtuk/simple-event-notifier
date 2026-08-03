# AWS Work Eventer — project rules

Project-specific rules. These sit **on top of** the shared constitution in `.agents/general.md`
and the language/framework guidance it indexes; they do not replace it.

## Architecture — binding

Two accepted ADRs govern the shape of this system. Read them before writing code or planning a
story. The canonical index is the **ADR table in `README.md`** — this file deliberately does not
duplicate it.

- **`2026-08-03-0028-layered-architecture`** — Application Model, a Repository in front of every
  external system, Transformers as the only code permitted to know a foreign shape, Business Logic
  Services transiting Application Model values only, and one functional area per 3P integration.
- **`2026-08-03-0035-effect-as-default-idiom`** — Effect as the default for schema, code structure,
  and async.

## Stack defaults — binding

| Concern | Default |
| :--- | :--- |
| Language / runtime | TypeScript, Node ≥24, ESM |
| Validation | **`effect/Schema` only — no Zod.** Types are derived via `typeof X.Type` |
| Dependency injection | Effect `Context.Tag` + `Layer` (not a DI container, not manual wiring) |
| Async / effects | **`Effect<A, E, R>`** for anything effectful; errors in the typed error channel as `Schema.TaggedError` |
| Pure fallible / partial | `Either<A, E>` / `Option<A>` — do **not** wrap pure code in `Effect` |
| Raw `Promise` | **Only** at the outermost process boundary (Lambda `handler`, CLI `main`), via `Effect.runPromise` |
| Monorepo | pnpm workspaces + turbo |
| Lint / format | biome |
| Test | vitest (+ `@effect/vitest`); fixtures over mocks per `.agents/tests.md` |
| Bundle | tsup |
| IaC | Terraform |

**The one-line test for async:** if a function touches the network, filesystem, clock, environment
or randomness, it returns `Effect`. If it is pure but can fail, it returns `Either`. If it is pure
and total, it returns the value.

## Event model is a published contract

The canonical `Event` JSON and the `{timestamp}.{type}.{priority}.{source}.{name}.json` object-key
scheme are consumed by the S3 bucket's entire history, by naive `aws s3 sync` clients, and by an
npm-published CLI. Treat it as a **versioned interface**: build keys only through the `event-model`
codec, and never re-declare its field bounds (`Priority`, `NoDotString`, `IsoInstant`) in a
consumer — import them, or the contract forks.

## Project management — Airtable

PM items live in Airtable (base `appnae8GXuj1rNVoQ`), operated over the Web API per
`.agents/project-tooling/airtable.md`. **There is no Airtable MCP server.**

This repo's topology matches **neither** documented mode cleanly, so do not infer it:

- The single Projects row **`recAmtlL5Goesb0p1`** ("AWS Work Eventer", `Item ID: aws-work-eventer`,
  ticket prefix **`AWE`**) represents **the repository**, not one feature.
- Plan **stories** are rows in the **Stories** table (`tblpJmL4dJ7Q4rw3U`) — *not* Tasks.
- Plan **features** have **no Airtable row**; they exist only as local `feature.md`.

Ticket numbers come from the **Global** record `recO6swk10yAIcJqn` field `Total Items` (computed —
never PATCH it) plus one, prefixed `AWE-`. **That counter is global across every project in the
base, so `AWE-` numbers are deliberately non-contiguous** — a large jump is correct, not a bug.

## Reminders that are easy to get wrong here

- Two CLIs in this repo have **opposite failure contracts**: the Claude Code hook CLI must exit `0`
  on failure to protect the agent session; the push CLI must exit **non-zero** so automation
  detects a failed push. Document it in both READMEs.
- Never stage `.agents/` (except `.agents/plans/`), `.claude/`, or `AGENTS.md`. `.agents/plans/.active`
  is never tracked.
