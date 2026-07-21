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
  "source": "github",                      // no "." — which system the event is ABOUT; key segment
  "name": "new-pull-request",              // no "." — key segment
  "producer": "github-webhook",            // no "." — the logical ORIGIN (hostname, or github-webhook / github-poller)
  "eventId": "5b1c8e40-84a1-11f1",         // no "." — provider delivery/event id, else a content hash
  "acknowledged": false,                   // triage flag, flipped by a client
  "handled": false,                        // triage flag, flipped by a client
  "workItem": "https://…",                 // optional ticket link, stored verbatim (never normalized)
  "payload": { }                           // opaque source-specific JSON
}
```

`source` and `producer` are different axes: `source` is *which system the event is about* (`github`),
`producer` is *what emitted it* (`github-webhook`, `github-poller`, or a machine hostname for a local
producer). Two producers can report the same source, and the key keeps them apart.

## The object key

```
{timestamp}.{type}.p{priority}.{source}.{name}.{producer}.{eventId}.json
2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.github-webhook.5b1c8e40.json
```

The ISO instant leads so keys sort chronologically — that is what lets a consumer treat "the last
key I processed" as a high-water mark and use `ListObjectsV2` `StartAfter` to catch up. The `.`
delimiters are structural, so **every** segment (`source`, `name`, `producer`, `eventId`) may not
contain one; producers normalise dotted values (`github.com` → `github-com`) before constructing an
event, and `eventId` is either a provider id already free of dots or a `contentHashId` (hex).

**The timestamp's millisecond fraction is mandatory and exactly three digits** — the shape
`Date.prototype.toISOString()` emits. This is load-bearing, not cosmetic: a variable-width fraction
makes an earlier event sort after a later one, and a consumer's high-water mark then skips it
permanently. The full argument lives in one place, `src/event.ts` → `isoInstantPattern`; it is not
restated here so it cannot drift.

**Key order is not write order.** Even with fixed-width instants, the key's timestamp is the
*producer's* clock, so two events sharing a millisecond, or producers with skewed clocks, can be
written in an order the key sort does not reflect. Consumers that need every event must not rely on a
bare high-water mark — see `apps/desktop-notifier/src/poller.ts` and `feature.md` § Follow-up
candidates.

**Priority is exactly one digit** (`p5`, never `p05`), so the codec is injective:
`key → components → key` is the identity, and two different keys never decode to the same components.

**One object key denotes one event.** The trailing `{producer}.{eventId}` pair is what makes this
true. `eventId` carries the provider's own delivery/event id — `X-GitHub-Delivery`, a notification or
activity id — or, for a producer with none, a `contentHashId` of the body. So two genuinely-distinct
events can no longer build a byte-identical key: even when they share a timestamp and classification
— the *norm* for the second-precision GitHub pollers, where every item in a poll batch shares a
millisecond — their `eventId`s differ, and both objects survive.

**Re-delivery is idempotent.** Because a provider's delivery id is stable, the *same* event
redelivered (a GitHub manual redelivery, a poller re-reading an item it already wrote) rebuilds the
*same* key and overwrites itself with identical bytes — not a duplicate. That is why the webhook
handler's dedupe and the poller's seen-set are an optimisation (they save the redundant write), not
the thing standing between you and duplicate history: the key scheme is.

> This closes the *overwrite* collision. It does **not** close the separate *ordering* hazard below
> (a consumer skipping a sibling that still exists) — that is a consumer-side lookback-window change,
> a decided follow-up in `.agents/plans/github-integration/feature.md`.

## API

| Export | Purpose |
| :--- | :--- |
| `EventSchema`, `Event`, `EventEncoded` | The effect `Schema` and its decoded / encoded types |
| `parseEvent`, `parseEventJson` | Decode untrusted input → `Either<Event, EventModelError>` |
| `encodeEvent`, `encodeEventJson` | Encode a typed event back to its stored JSON form |
| `buildKey`, `buildEventKey`, `toKeyComponents` | Build an object key (total — components are already valid) |
| `parseKey`, `EventKeyFromString` | Decode an object key → `Either<EventKeyComponents, EventModelError>` |
| `eventTypes`, `priorityBounds`, `schemaVersions` | Runtime value lists (`as const` objects, not enums) |
| `contentHashId` | A stable, dot-free `eventId` for a producer with no provider delivery id |
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
