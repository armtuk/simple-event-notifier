import { Schema } from "effect"

/**
 * The canonical personal-events event shape. This is the load-bearing contract: every producer
 * (webhook ingest, agents, persistent clients) and every consumer (UI, device clients, a naive
 * `aws s3 sync`) couples to it, and the objects live in S3 as permanent history. Treat it as a
 * versioned interface — additive changes only, behind a bumped `schemaVersion`.
 */

export const schemaVersions = { v1: 1 } as const

export type SchemaVersion = (typeof schemaVersions)[keyof typeof schemaVersions]

export const eventTypes = { alert: "alert", notification: "notification" } as const

export type EventType = (typeof eventTypes)[keyof typeof eventTypes]

export const priorityBounds = { min: 1, max: 8 } as const

/** The `.` delimiter of the object key is structural, so key-bearing segments may not contain one. */
export const noDotPattern = /^[^.]+$/

/**
 * ISO-8601 instant in UTC, e.g. `2026-06-28T18:44:30.123Z`. Stored as the literal string so the
 * object key and the body agree byte-for-byte.
 *
 * The millisecond fraction is **mandatory and exactly three digits** — the exact shape
 * `Date.prototype.toISOString()` emits. This is load-bearing, not cosmetic: the instant leads the
 * object key, and consumers rely on keys sorting chronologically to use "the last key I processed"
 * as a high-water mark. A variable-width fraction breaks that, because `.` (0x2E) sorts below every
 * digit and `Z` (0x5A) sorts above every digit — so `…02Z…` > `…02.500Z…` and `…02.12Z…` >
 * `…02.123Z…`, i.e. an *earlier* event sorts *after* a later one and `StartAfter` skips it forever.
 * Fixing the width makes every instant the same length, so lexicographic order is chronological
 * order. See `event.spec.ts` → "lexicographic order matches chronological order".
 */
export const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const IsoInstant = /*#__PURE__*/ Schema.String.pipe(
  Schema.pattern(isoInstantPattern, {
    identifier: "IsoInstant",
    description: "an ISO-8601 UTC instant with exactly three fractional digits, such as 2026-06-28T18:44:30.123Z"
  })
)

export const NoDotString = /*#__PURE__*/ Schema.NonEmptyString.pipe(
  Schema.pattern(noDotPattern, {
    identifier: "NoDotString",
    description: "a non-empty string containing no '.' (it is an object-key segment)"
  })
)

export const EventTypeSchema = /*#__PURE__*/ Schema.Literal(eventTypes.alert, eventTypes.notification).annotations({
  identifier: "EventType"
})

export const Priority = /*#__PURE__*/ Schema.Int.pipe(
  Schema.between(priorityBounds.min, priorityBounds.max, {
    identifier: "Priority",
    description: "an attention level from 1 (highest) to 8 (lowest)"
  })
)

/**
 * A work-item link, kept as the **string the producer wrote**, validated for parseability but never
 * reserialized. `Schema.URL` would decode to a `URL` instance whose encode is `url.toString()`, and
 * `URL` normalizes — `https://github.com` becomes `https://github.com/`, `HTTPS://GitHub.com/Foo`
 * becomes `https://github.com/Foo`. With S3 as the permanent source of record, a triage client that
 * does `parseEvent → flip acknowledged → encodeEvent → PutObject` would silently rewrite the stored
 * bytes. Identity encode also means consumers get a `string`, so `event.workItem === someString`
 * behaves as anyone would expect. Call `new URL(event.workItem)` if you need the parsed form.
 */
export const WorkItemUrl = /*#__PURE__*/ Schema.String.pipe(
  Schema.filter((value: string) => URL.canParse(value), {
    identifier: "WorkItemUrl",
    description: "an absolute URL, stored verbatim (never normalized)"
  })
)

export const EventSchema = /*#__PURE__*/ Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersions.v1),
  timestamp: IsoInstant,
  eventType: EventTypeSchema,
  priority: Priority,
  source: NoDotString,
  name: NoDotString,
  /**
   * The **logical origin** of the event — a hostname for a local producer (`os.hostname()`), or an
   * explicit constant for a deployed one (`github-webhook`, `github-poller`). Distinct from `source`
   * (which system the event is *about*): two producers can report the same `source`, and `producer`
   * is part of what keeps their object keys apart.
   */
  producer: NoDotString,
  /**
   * The provider's own delivery/event id where one exists (`X-GitHub-Delivery`, a notification or
   * activity id), else a content hash of the body (`contentHashId`). It is the segment that makes
   * the object key **identify an event**: two genuinely-distinct events can no longer collide onto
   * one key, and re-delivering the *same* event rebuilds the *same* key — an idempotent overwrite
   * with identical bytes rather than a duplicate.
   */
  eventId: NoDotString,
  acknowledged: Schema.Boolean,
  handled: Schema.Boolean,
  workItem: Schema.optionalWith(WorkItemUrl, { exact: true }),
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown })
}).annotations({ identifier: "Event" })

export type Event = typeof EventSchema.Type

export type EventEncoded = typeof EventSchema.Encoded
