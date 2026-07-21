import { type Event, parseEvent, schemaVersions } from "@personal-events/event-model"
import { Either } from "effect"
import { classify } from "./classify.ts"
import type { CompiledConfig } from "./compile.ts"
import { TransformError } from "./errors.ts"
import type { NormalizedEvent } from "./normalized-event.ts"

/**
 * The template's one piece of business logic: a **pure** `NormalizedEvent` → canonical `Event`,
 * with classification supplied by config rather than by code. No I/O, no clock, no logging — the
 * timestamp arrives on the normalized event because *who decides what instant an event happened at*
 * is a provider question (a webhook has no reliable event-time; an inbox item has `updated_at`),
 * and a pure function must not answer it by reading a clock.
 *
 * Curried config-first, so an edge compiles once at start-up and holds a
 * `(normalized) => Either<Event, TransformError>` per integration.
 *
 * The candidate is re-validated through `parseEvent` rather than cast. Config is untrusted input
 * too: a `name` an operator typed with a `.` in it, or a normalizer that let a dotted repository
 * name reach `source`, would otherwise produce an object whose S3 key cannot be parsed back —
 * permanent, undetectable corruption of the event log. One `parseEvent` call makes that a typed
 * `Left` at the edge instead.
 */

export const transform =
  (compiled: CompiledConfig) =>
  (normalized: NormalizedEvent): Either.Either<Event, TransformError> => {
    const { output, matchKey } = classify(compiled, normalized.trigger)
    return Either.mapLeft(
      parseEvent(toCandidate(normalized, output.eventType, output.priority, output.name)),
      failure => new TransformError({ integration: compiled.integration, matchKey, reason: failure.message })
    )
  }

/**
 * `exactOptionalPropertyTypes` is on, so a present-but-`undefined` `workItem` is not the same as an
 * absent one — and `EventSchema` declares it `exact`. Build the optional key only when it has a value.
 */
const toCandidate = (
  normalized: NormalizedEvent,
  eventType: Event["eventType"],
  priority: Event["priority"],
  name: string | undefined
): Record<string, unknown> => ({
  schemaVersion: schemaVersions.v1,
  timestamp: normalized.timestamp,
  eventType,
  priority,
  source: normalized.source,
  name: name ?? normalized.name,
  producer: normalized.producer,
  eventId: normalized.eventId,
  acknowledged: false,
  handled: false,
  ...(normalized.workItem === undefined ? {} : { workItem: normalized.workItem }),
  payload: normalized.payload
})
