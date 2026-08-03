---
id: 2026-08-03-0035-effect-as-default-idiom
title: Effect is the default idiom — schema, code structure, and async
status: Accepted
created: 2026-08-03
updated: 2026-08-03
supersedes: none
superseded-by: none
---

# Effect is the default idiom — schema, code structure, and async

## Decision

Effect (`effect@^3`) is the default across three axes. This is binding for all new code.

### 1. Schema — the only validation library

`effect/Schema` is the sole validation mechanism. **Zod is not used.** Every boundary decodes
through a Schema: argv, stdin, the S3 object body, every third-party payload, and every config
file. Model types are **derived** (`export type X = typeof XSchema.Type`), never hand-written as a
parallel interface that can drift from its schema.

### 2. Code structure — services and Layers

Services are Effect services: `Context.Tag` for the interface, `Layer` for construction and wiring.
`.agents/object-types.md` §"State and Data Containing Objects" requires service objects to be
created from an injection context and **explicitly exempts Effect Layers** — Layers *are* this
project's dependency-injection mechanism. Composition is `Layer.mergeAll` / `Effect.provide`, not a
DI container and not manual constructor threading.

### 3. Async — `Effect`, not `Promise`

Anything that performs I/O or can fail returns `Effect<A, E, R>`. Errors live in the **typed error
channel** as `Schema.TaggedError` subclasses; they are never thrown and never flattened into a
`Promise` rejection.

**Raw `Promise` appears at exactly one place: the outermost process boundary**, where a foreign
runtime demands it — a Lambda `handler` export, a CLI `main`, a hook entry point. There it is
produced by `Effect.runPromise` / `Effect.runPromiseExit` and nowhere else.

### The rule of thumb

| The function… | Returns |
| :--- | :--- |
| touches network, filesystem, clock, env, or randomness | `Effect<A, E, R>` |
| is pure but can fail | `Either<A, E>` |
| is pure and may legitimately have no answer | `Option<A>` |
| is pure and total | the value |

An `Effect` is for **effects**. A pure fallible transform — classification, key building, config
compilation — stays `Either` and gains nothing from being wrapped.

## Context

The guidance already names Effect the default: `.agents/frameworks/node/preferences.md` says
*"When using effect (the default): Use effect for schema validation, transforms, and http/https
client operations,"* and `.agents/languages/typescript/typescript.md` §"Return Values" defers to
Effect's `_tag` convention when the project uses Effect.

**But the existing plans are half-Effect, and that is the problem this ADR resolves.** They use
Schema and `Either` for pure code while typing every effectful boundary as a raw `Promise`:

| Signature | Plan |
| :--- | :--- |
| `pushEvent(client, bucket, event): Promise<PushResult>` | AWE-160 — Shared S3 event writer |
| `S3EventRepository.putEvents(events): Promise<PutEventsResult>` | AWE-155 — Generic webhook ingest |
| `handle(req: RawRequest): Promise<WebhookOutcome>` | AWE-155 / AWE-156 |
| `readPayload(argv): Promise<string>`, `run(input): Promise<RunResult>` | AWE-162 — Publishable hook CLI |
| `GithubNotificationsRepository.poll(cursor): Promise<PollResult>` | AWE-157 — GitHub activity poller |

A half-Effect codebase is worse than either consistent choice. It pays Effect's full learning and
tooling cost while forfeiting the benefits — typed error channels, resource safety, built-in
retry/scheduling, composable dependency injection — at precisely the boundaries where failure
actually happens.

That lands hardest against the layering decision. ADR `2026-08-03-0028-layered-architecture` puts a
**Repository** in front of every external system, and those Repositories are exactly where errors,
retries, rate limits, credentials and resource lifetimes live. Typing them as `Promise` leaves the
error channel untyped at the one boundary the layering ADR identifies as load-bearing.

Two further pulls toward full Effect:

- `.agents/guidance/api-integrations.md` requires back-off/retry honouring `X-RateLimit-*` and
  `Retry-After`, plus per-second/minute/hour/day throughput tracking. That is `Effect.retry` with a
  `Schedule`, not hand-rolled loops and timers.
- The system's failure modes are almost entirely I/O — missing credentials, unreachable bucket,
  malformed payload, 429s. Typed error channels are most valuable exactly there.

## Blast radius

- **Every package.** Effect colours every signature it touches.
- **Every Repository and Service signature in the existing plans** — the five listed above must be
  restated as `Effect`, and AWE-153 — Reusable integration template's `readConfigFile(path): Promise<…>`
  and `SecondaryProcessor.process(event): Promise<void>` along with them.
- **Dependency injection shape** — `Layer` graphs replace constructor wiring across the system.
- **Testing** — `@effect/vitest`, or vitest with `Effect.runPromise` at the test boundary. Test
  doubles become alternative `Layer`s rather than mocks, which suits `.agents/tests.md`'s
  fixtures-over-mocks stance.
- **Retry / rate limiting** — `Schedule`-based, per `api-integrations.md`.
- **Onboarding cost** — the single largest downside; Effect has a steep learning curve and every
  contributor pays it.

## Alternatives & trade-offs

**Zod plus plain `async`/`await`.** *Rejected.* Contradicts the stated default in
`node/preferences.md`, discards the typed error channel, and — since the plans already specify
Effect Schema throughout — would mean actively *removing* Effect rather than declining to add it.

**Effect Schema for validation, `Promise` for async — the current de-facto state.** *Rejected.*
This is the half-and-half position described above: full cost, partial benefit, untyped errors at
the Repository boundaries. It is also unstable — every new story must re-litigate which style
applies, which is how the inconsistency arose in the first place.

**Full Effect including `Stream` everywhere.** *Accepted in principle, not mandated.* `Stream` is
appropriate where it genuinely helps — the sync client's polling loop is a plausible fit — but
requiring it for all iteration would be cargo-culting. Use it where the pull-based, resource-safe
semantics earn their place.

## Reversibility

**One-way door in practice.** Effect is pervasive by design: it appears in every effectful
signature, the dependency-injection graph, and the test harness. Reversing it means rewriting every
boundary in the system, not swapping a library. The decision is cheap to make now — the repo has no
source code yet — and expensive to revisit later, which is precisely why it is being pinned before
implementation begins.

## References

- ADR `2026-08-03-0028-layered-architecture` — the layering this idiom serves; its Repository
  boundary is the main motivation for typed error channels
- `.agents/frameworks/node/preferences.md` — Effect named as the default
- `.agents/frameworks/effect/effect.md` — module index; the per-module API references under
  `.agents/cache/effect/v3/` are to be loaded at implementation time, not during planning
- `.agents/languages/typescript/typescript.md` §"Return Values / Objects" — `_tag` convention,
  `Either`/`Option` acceptance
- `.agents/object-types.md` §"State and Data Containing Objects" — the Effect-Layer exemption from
  constructor-based DI
- `.agents/guidance/api-integrations.md` — retry, back-off and rate-limit obligations
- `.agents/tests.md` — fixtures over mocks, which Layer-based test doubles support
- No implementing PR yet; this records a decision taken during planning on 2026-08-03.
