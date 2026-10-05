import { buildEventKey, type Event, type EventModelError, encodeEventJson } from "@personal-events/event-model"
import { Either } from "effect"

/**
 * The Compute half of writing an event: turn typed events into the exact `(key, body)` pairs that
 * will land in S3, with no I/O involved. Separating it from the `PutObject` calls is what makes the
 * interesting property — *the key and the body agree, and both go through the contract* — testable
 * without an AWS client.
 *
 * The body is produced by `encodeEventJson`, not `JSON.stringify`, on purpose. The contract's
 * encoder is what guarantees `workItem` is written back byte-identically rather than through
 * `URL`'s normalization, and it is what will apply any future schema-version transform. Stringifying
 * the in-memory object would work today and silently stop being correct the first time the contract
 * grows an encode step.
 *
 * All-or-nothing: one unencodable event fails the batch rather than writing a partial one. A
 * producer that cannot encode what it built has a defect, and half-writing its batch would leave the
 * permanent log in a state nobody planned.
 */

export interface EventObject {
  readonly key: string
  readonly body: string
}

export const toEventObjects = (events: readonly Event[]): Either.Either<readonly EventObject[], EventModelError> =>
  Either.all(events.map(toEventObject))

const toEventObject = (event: Event): Either.Either<EventObject, EventModelError> =>
  Either.map(encodeEventJson(event), body => ({ key: buildEventKey(event), body }))
