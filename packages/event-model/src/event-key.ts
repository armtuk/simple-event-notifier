import { Either, ParseResult, Schema } from "effect"
import { type EventModelError, eventModelError, eventModelErrorReasons } from "./errors.ts"
import { type Event, type EventType, EventTypeSchema, eventTypes, IsoInstant, NoDotString, Priority } from "./event.ts"

/**
 * The S3 object-key codec: `{timestamp}.{type}.{priority}.{source}.{name}.json`, e.g.
 * `2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json`.
 *
 * The leading ISO instant makes the bucket sort chronologically by key, which is what lets a
 * consumer treat "the last key I processed" as a high-water mark. The remaining segments let a
 * consumer triage from the key alone, without fetching the body.
 */

export const eventKeySuffix = ".json"

export const eventKeyPriorityPrefix = "p"

/** Anchored so a key with a missing, extra, or dotted segment fails rather than matching loosely. */
export const eventKeyPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\.([^.]+)\.p(\d+)\.([^.]+)\.([^.]+)\.json$/

export const EventKeyComponents = /*#__PURE__*/ Schema.Struct({
  timestamp: IsoInstant,
  eventType: EventTypeSchema,
  priority: Priority,
  source: NoDotString,
  name: NoDotString
}).annotations({ identifier: "EventKeyComponents" })

export type EventKeyComponents = typeof EventKeyComponents.Type

/** The aggregate → slice transform: a key is built from exactly these five fields of an event. */
export const toKeyComponents = (event: Event): EventKeyComponents => ({
  timestamp: event.timestamp,
  eventType: event.eventType,
  priority: event.priority,
  source: event.source,
  name: event.name
})

/** Total: the components are already schema-valid, so formatting them cannot fail. */
export const buildKey = ({ timestamp, eventType, priority, source, name }: EventKeyComponents): string =>
  `${timestamp}.${eventType}.${eventKeyPriorityPrefix}${priority}.${source}.${name}${eventKeySuffix}`

export const buildEventKey = (event: Event): string => buildKey(toKeyComponents(event))

export const parseKey = (key: string): Either.Either<EventKeyComponents, EventModelError> =>
  Either.mapLeft(decodeKey(key), error =>
    eventModelError(
      eventModelErrorReasons.invalidEventKey,
      `Invalid event object key "${key}": ${ParseResult.TreeFormatter.formatErrorSync(error)}`
    )
  )

const eventTypeByName: Partial<Record<string, EventType>> = eventTypes

/**
 * Splits the key on its structural `.` delimiters. Returns the *encoded* component shape; range
 * and pattern validation is left to `EventKeyComponents` so failures name the offending field.
 */
const matchKey = (key: string): Either.Either<typeof EventKeyComponents.Encoded, string> => {
  const [, timestamp, rawEventType, rawPriority, source, name] = eventKeyPattern.exec(key) ?? []
  const eventType = rawEventType === undefined ? undefined : eventTypeByName[rawEventType]
  return timestamp === undefined || eventType === undefined || rawPriority === undefined || source === undefined || name === undefined
    ? Either.left(
        `expected {timestamp}.{alert|notification}.p{priority}.{source}.{name}${eventKeySuffix} with no "." inside the source or name segments`
      )
    : Either.right({ timestamp, eventType, priority: Number.parseInt(rawPriority, 10), source, name })
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
