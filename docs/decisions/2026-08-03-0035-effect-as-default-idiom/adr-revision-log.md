## 2026-08-03T07:35:00Z — Initial decision recorded — Alex Turner

First draft, authored immediately after ADR `2026-08-03-0028-layered-architecture` and during the
replanning of features F1–F5. Pins Effect as the default idiom on three axes: `effect/Schema` as
the sole validation library (no Zod), `Context.Tag` + `Layer` as the dependency-injection
mechanism, and `Effect<A, E, R>` as the return type of anything effectful — with raw `Promise`
confined to the outermost process boundary via `Effect.runPromise`.

Records the rule-of-thumb table separating `Effect` (effects) from `Either` (pure fallible) and
`Option` (pure partial), so that pure transforms are not needlessly wrapped.

Written specifically to resolve the **half-Effect** state of the existing plans, which paired
Effect Schema and `Either` in pure code with raw `Promise` at every Repository and handler
boundary. The five offending signatures are enumerated in the body's Context section so the
follow-up plan edits have a checklist.
