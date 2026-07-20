import { Either, ParseResult, Schema } from "effect"
import { describeCause } from "./describe-cause.ts"
import { type EventModelError, eventModelError, eventModelErrorReasons } from "./errors.ts"
import { type Event, type EventEncoded, EventSchema } from "./event.ts"

/**
 * The boundary between untrusted bytes and the typed domain. Everything crossing into the system
 * (an S3 object body, a webhook payload) comes through `parseEvent`; everything crossing out
 * (an object body to write) goes through `encodeEvent`. Nothing here throws.
 */

export const parseEvent = (raw: unknown): Either.Either<Event, EventModelError> =>
  Either.mapLeft(decodeEvent(raw), error =>
    eventModelError(eventModelErrorReasons.invalidEvent, `Invalid event: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)
  )

export const parseEventJson = (json: string): Either.Either<Event, EventModelError> => Either.flatMap(parseJson(json), parseEvent)

export const encodeEvent = (event: Event): Either.Either<EventEncoded, EventModelError> =>
  Either.mapLeft(encodeEventValue(event), error =>
    eventModelError(eventModelErrorReasons.invalidEvent, `Unencodable event: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)
  )

export const encodeEventJson = (event: Event): Either.Either<string, EventModelError> =>
  Either.map(encodeEvent(event), encoded => JSON.stringify(encoded))

const parseJson = (json: string): Either.Either<unknown, EventModelError> =>
  Either.try({
    try: (): unknown => JSON.parse(json),
    catch: cause => eventModelError(eventModelErrorReasons.invalidEventJson, `Event body is not valid JSON: ${describeCause(cause)}`)
  })

const decodeEvent = /*#__PURE__*/ Schema.decodeUnknownEither(EventSchema, { errors: "all" })

const encodeEventValue = /*#__PURE__*/ Schema.encodeEither(EventSchema, { errors: "all" })
