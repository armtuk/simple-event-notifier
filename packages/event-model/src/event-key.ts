import { Either, ParseResult, Schema } from "effect"
import { type EventModelError, eventModelError, eventModelErrorReasons } from "./errors.ts"
import { type Event, type EventType, EventTypeSchema, IsoInstant, NoDotString, Priority } from "./event.ts"

/**
 * The S3 object-key codec: `{timestamp}.{type}.{priority}.{source}.{name}.{producer}.{eventId}.json`,
 * e.g. `2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.github-webhook.5b1c8e40.json`.
 *
 * The leading ISO instant makes the bucket sort chronologically by key, which is what lets a
 * consumer treat "the last key I processed" as a high-water mark. That property depends entirely on
 * every timestamp having the same width — see `event.ts` → `isoInstantPattern` for why, which is the
 * single normative statement of this invariant. The middle segments let a consumer triage from the
 * key alone, without fetching the body.
 *
 * The trailing `{producer}.{eventId}` pair is what makes a key **identify an event**. Without it two
 * genuinely-distinct events that shared a timestamp and classification (the norm for the
 * second-precision GitHub pollers) built a byte-identical key and the second silently overwrote the
 * first. With it, a provider delivery id keeps distinct events apart and makes a *re-delivery* of the
 * same event rebuild the same key — an idempotent overwrite with identical bytes, not a duplicate.
 */

export const eventKeySuffix = ".json"

export const eventKeyPriorityPrefix = "p"

/**
 * Anchored so a key with a missing, extra, or dotted segment fails rather than matching loosely.
 *
 * The timestamp group mirrors `isoInstantPattern` exactly — fixed-width, so keys sort
 * chronologically. Priority is captured as a single digit rather than `\d+` so the codec is
 * **injective**: `p05` and `p5` would otherwise decode to the same event while re-encoding to only
 * one of them, meaning two distinct S3 keys denote one event and `key → components → key` is not
 * the identity. The type segment stays loose (`[^.]+`) on purpose so an unknown value is rejected
 * by `EventTypeSchema` with a message naming `eventType`, rather than looking like a shape error.
 */
export const eventKeyPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.([^.]+)\.p(\d)\.([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)\.json$/

export const EventKeyComponents = /*#__PURE__*/ Schema.Struct({
  timestamp: IsoInstant,
  eventType: EventTypeSchema,
  priority: Priority,
  source: NoDotString,
  name: NoDotString,
  producer: NoDotString,
  eventId: NoDotString
}).annotations({ identifier: "EventKeyComponents" })

export type EventKeyComponents = typeof EventKeyComponents.Type

/** The aggregate → slice transform: a key is built from exactly these seven fields of an event. */
export const toKeyComponents = (event: Event): EventKeyComponents => ({
  timestamp: event.timestamp,
  eventType: event.eventType,
  priority: event.priority,
  source: event.source,
  name: event.name,
  producer: event.producer,
  eventId: event.eventId
})

/** Total: the components are already schema-valid, so formatting them cannot fail. */
export const buildKey = ({ timestamp, eventType, priority, source, name, producer, eventId }: EventKeyComponents): string =>
  `${timestamp}.${eventType}.${eventKeyPriorityPrefix}${priority}.${source}.${name}.${producer}.${eventId}${eventKeySuffix}`

export const buildEventKey = (event: Event): string => buildKey(toKeyComponents(event))

export const parseKey = (key: string): Either.Either<EventKeyComponents, EventModelError> =>
  Either.mapLeft(decodeKey(key), error =>
    eventModelError(
      eventModelErrorReasons.invalidEventKey,
      `Invalid event object key "${key}": ${ParseResult.TreeFormatter.formatErrorSync(error)}`
    )
  )

/**
 * Splits the key on its structural `.` delimiters. This decides only whether the key has the right
 * *shape*; every *value* judgement — is the timestamp well formed, is the type known, is the
 * priority in range — is left to `EventKeyComponents` so the failure names the offending field
 * rather than reporting a generic "malformed key".
 *
 * The `eventType` cast is the boundary: the regex proves the segment contains no `.`, and
 * `EventTypeSchema` is what actually gates the value. Resolving it here instead (through a
 * `Record` lookup) would fold an unknown-but-well-shaped type back into the shape error.
 */
const matchKey = (key: string): Either.Either<typeof EventKeyComponents.Encoded, string> => {
  const [, timestamp, rawEventType, rawPriority, source, name, producer, eventId] = eventKeyPattern.exec(key) ?? []
  return timestamp === undefined ||
    rawEventType === undefined ||
    rawPriority === undefined ||
    source === undefined ||
    name === undefined ||
    producer === undefined ||
    eventId === undefined
    ? Either.left(
        `expected {timestamp}.{type}.p{priority}.{source}.{name}.{producer}.{eventId}${eventKeySuffix}, where {timestamp} has exactly three fractional digits, {priority} is one digit, and no segment contains "."`
      )
    : Either.right({
        timestamp,
        eventType: rawEventType as EventType,
        priority: Number.parseInt(rawPriority, 10),
        source,
        name,
        producer,
        eventId
      })
}

/** A `Schema` over the key string so the codec composes with other effect schemas. */
export const EventKeyFromString = /*#__PURE__*/ Schema.transformOrFail(Schema.String, EventKeyComponents, {
  strict: true,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: parseOptions is positional in effect's decode signature; ast is what we need.
  decode: (key, parseOptions, ast) =>
    Either.match(matchKey(key), {
      onLeft: message => ParseResult.fail(new ParseResult.Type(ast, key, message)),
      onRight: ParseResult.succeed
    }),
  encode: components => ParseResult.succeed(buildKey(components))
}).annotations({ identifier: "EventKeyFromString" })

const decodeKey = /*#__PURE__*/ Schema.decodeUnknownEither(EventKeyFromString, { errors: "all" })
