# `@personal-events/integration-core`

The **reusable integration template**. Every event source in personal-events — GitHub first, Claude
Code next — plugs into this package rather than re-inventing classification. It is **pure**: no
network, no clock, no logging, and (apart from one deliberately isolated file reader) no I/O.

Adding an integration is meant to be **a mapping config plus a normalizer**. If you find yourself
changing this package to add one, that is the signal something belongs here that isn't here yet —
raise it rather than working around it.

## The seam

```
raw provider payload ──[ your normalizer ]──▶ NormalizedEvent ──[ transform(compiled) ]──▶ Event
        (provider package knows this)                              (this package knows this)
```

A **normalizer** is the only code that knows a provider's wire shapes. A **transform** is the only
code that decides classification. Neither knows the other's half, which is why the framework has
never needed a GitHub-shaped exception.

## The mapping config

```jsonc
{
  "integration": "github",
  "rules": [
    { "trigger": { "channel": "webhook", "event": "pull_request", "action": "opened" },
      "output":  { "eventType": "alert", "priority": 5, "name": "new-pull-request" } },
    { "trigger": { "channel": "notification", "reason": "mention" },
      "output":  { "eventType": "notification", "priority": 4, "name": "mention" } }
  ],
  "default": { "eventType": "notification", "priority": 3 }
}
```

- **`channel` is the trigger discriminant, not `source`.** `source` already means the provider
  identity on a canonical `Event` (`"github"`). A channel names *how the event reached us* —
  `webhook`, `notification`, `events_api` — and it is what keeps two provider namespaces that share
  vocabulary (a webhook `pull_request`+`review_requested` vs an inbox `reason: review_requested`)
  from matching each other's rules.
- **`default` is mandatory.** An unmapped trigger classifies to it and is written. Nothing is ever
  dropped for being unrecognised; `classify(...).matched === false` is how an edge knows to log the
  gap.
- **`output.name` is optional.** When present it is the event's name; when absent the normalizer's
  name is used. That is what lets a config give `pull_request.opened` the label `new-pull-request`
  without the framework ever deriving a name from provider data.
- **Field schemas come from `@personal-events/event-model`.** The 1–8 priority bound and the no-dot
  rule are the canonical contract's, imported, never restated — a second declaration here is a fork
  that drifts.

## API

| Export | Purpose |
| :--- | :--- |
| `MappingConfigSchema`, `MappingRuleSchema`, `OutputSchema` | The config contract and its derived types |
| `TriggerSchema`, `matchKey` | The open trigger shape and its canonical, order-independent lookup key |
| `loadMappingConfig(raw, { knownProcessors })` | Validate + compile untrusted config → `Either<CompiledConfig, …>` |
| `readConfigFile(path)` | The **only** I/O — read a config file's bytes (Gather) |
| `compileMappingConfig(config)` | Rule list → `ReadonlyMap` lookup, once, so matching is O(1) per event |
| `classify(compiled, trigger)` | `{ output, matchKey, matched }` — the edge's signal that a rule was missing |
| `transform(compiled)(normalized)` | The pure classification: `Either<Event, TransformError>` |
| `NormalizedEventSchema` | The provider ⇄ framework seam |
| `SourceAdapter`, `SecondaryProcessor` | **Interfaces only** — no implementations ship here |

Nothing throws. Every fallible boundary returns an `Either` whose left carries a `Schema.TaggedError`
naming the offending value.

## Two things it deliberately does not do

- **It does not derive a name from provider data.** That is the normalizer's job; the framework only
  chooses between the configured label and the one it was handed.
- **It does not run secondary processors.** The interface is fixed and `loadMappingConfig` refuses a
  config naming a hook nobody registered — but whether a hook runs inline (inside a webhook's ~10 s
  budget) or enqueued after the S3 write (where a failure cannot un-write the event) is an open
  design question, deferred deliberately. See `src/secondary-processor.ts`.

## Exemplars

`exemplars/` holds mapping configs, `valid-config-*.json` and `invalid-config-*.json`, one per
failure mode. They drive the spec tables. These are configs — this package's own concern; canonical
*event* bodies live in `@personal-events/event-model` and must not be copied here.
