# `@personal-events/event-model`

The load-bearing contract of the personal-events system: the canonical event shape and the S3
object-key codec. Every producer and every consumer couples to this package, and the objects it
describes live in S3 as permanent history — **treat it as a versioned interface**.

## The event body

```jsonc
{
  "schemaVersion": 1,
  "timestamp": "2026-06-28T18:44:30.123Z", // ISO-8601 UTC instant, EXACTLY three fractional digits
  "eventType": "alert",                    // "alert" (needs attention) | "notification" (info)
  "priority": 5,                           // integer 1 (highest) – 8 (lowest)
  "source": "github",                      // no "." — it is an object-key segment
  "name": "new-pull-request",              // no "." — it is an object-key segment
  "acknowledged": false,                   // triage flag, flipped by a client
  "handled": false,                        // triage flag, flipped by a client
  "workItem": "https://…",                 // optional ticket link, stored verbatim (never normalized)
  "payload": { }                           // opaque source-specific JSON
}
```

## The object key

```
{timestamp}.{type}.p{priority}.{source}.{name}.json
2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json
```

The ISO instant leads so keys sort chronologically — that is what lets a consumer treat "the last
key I processed" as a high-water mark and use `ListObjectsV2` `StartAfter` to catch up. The `.`
delimiters are structural, so `source` and `name` may not contain one; producers normalise dotted
values (`github.com` → `github-com`) before constructing an event.

**The timestamp's millisecond fraction is mandatory and exactly three digits.** This is load-bearing,
not cosmetic. `StartAfter` is lexicographic, and `.` (0x2E) sorts below every digit while `Z` (0x5A)
sorts above every digit — so with a variable-width fraction `…02Z…` > `…02.500Z…` and `…02.12Z…` >
`…02.123Z…`, meaning an *earlier* event sorts *after* a later one and a consumer's high-water mark
skips it permanently. Fixing the width makes every instant the same length, so lexicographic order
is chronological order. `Date.prototype.toISOString()` already emits exactly this shape.

**Priority is exactly one digit** (`p5`, never `p05`), so the codec is injective: one object key
denotes one event, and `key → components → key` is the identity.

## API

| Export | Purpose |
| :--- | :--- |
| `EventSchema`, `Event`, `EventEncoded` | The effect `Schema` and its decoded / encoded types |
| `parseEvent`, `parseEventJson` | Decode untrusted input → `Either<Event, EventModelError>` |
| `encodeEvent`, `encodeEventJson` | Encode a typed event back to its stored JSON form |
| `buildKey`, `buildEventKey`, `toKeyComponents` | Build an object key (total — components are already valid) |
| `parseKey`, `EventKeyFromString` | Decode an object key → `Either<EventKeyComponents, EventModelError>` |
| `eventTypes`, `priorityBounds`, `schemaVersions` | Runtime value lists (`as const` objects, not enums) |
| `describeCause` | Renders an arbitrary thrown value as a line an operator can read |

Nothing here throws and nothing here does I/O: every entry point returns an `Either`, and the
failure carries a `reason` (`invalidEvent` / `invalidEventJson` / `invalidEventKey`) plus a message
naming the offending value and what was wrong with it.

## Versioning

`schemaVersion` is a literal `1`. A future change adds a new literal and widens the schema to a
union rather than mutating version 1 in place — objects already in the bucket must stay
interpretable forever.

## `workItem` is stored verbatim

`workItem` is a **string**, validated for parseability but never reserialized. It deliberately does
*not* use `Schema.URL`, whose encode is `url.toString()` — and `URL` normalizes
(`https://github.com` → `https://github.com/`, `HTTPS://GitHub.com/Foo` → `https://github.com/Foo`).
With S3 as the permanent source of record, a triage client that does
`parseEvent → flip acknowledged → encodeEvent → PutObject` would otherwise silently rewrite the
stored bytes. Identity encode also means consumers get a `string`, so `event.workItem === someString`
behaves as expected; call `new URL(event.workItem)` if you want the parsed form.

## Exemplars

`exemplars/` holds representative bodies — `valid-*.json` for the happy path and `invalid-*.json`
for each failure mode. They drive the spec tables; add a new one whenever a real producer surfaces
a shape the model has not seen.

**These are the contract's canonical test data, and consumers must not copy them.** They are
published from this package so every consumer's suite runs against the same bytes:

```ts
import { readExemplar, readExemplarEvent, readExemplarText } from "@personal-events/event-model/testing"
```

`exemplarReader(dir)` from the same module binds the reader to a consumer's own `exemplars/`
directory, for bodies that are genuinely that consumer's concern rather than the contract's.
