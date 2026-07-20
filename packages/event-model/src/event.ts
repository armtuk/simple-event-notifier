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

/** ISO-8601 instant in UTC, e.g. `2026-06-28T18:44:30.123Z`. Stored as the literal string so the object key and the body agree byte-for-byte. */
export const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export const IsoInstant = /*#__PURE__*/ Schema.String.pipe(
  Schema.pattern(isoInstantPattern, { identifier: "IsoInstant", description: "an ISO-8601 UTC instant such as 2026-06-28T18:44:30.123Z" })
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

export const EventSchema = /*#__PURE__*/ Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersions.v1),
  timestamp: IsoInstant,
  eventType: EventTypeSchema,
  priority: Priority,
  source: NoDotString,
  name: NoDotString,
  acknowledged: Schema.Boolean,
  handled: Schema.Boolean,
  workItem: Schema.optionalWith(Schema.URL, { exact: true }),
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown })
}).annotations({ identifier: "Event" })

export type Event = typeof EventSchema.Type

export type EventEncoded = typeof EventSchema.Encoded
