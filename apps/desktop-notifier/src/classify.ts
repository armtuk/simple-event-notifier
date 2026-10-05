import { type Event, parseEventJson } from "@personal-events/event-model"
import { Either } from "effect"
import type { PolledObject } from "./poller.ts"

/**
 * Compute: sorts polled object bodies into the ones that are events and the ones that are not.
 * Pure and total — a malformed object becomes a `RejectedObject` carrying its key and a reason,
 * never an exception, so one bad object cannot stall the objects behind it.
 */

export interface ParsedObject {
  readonly _tag: "ParsedObject"
  readonly key: string
  readonly event: Event
}

export interface RejectedObject {
  readonly _tag: "RejectedObject"
  readonly key: string
  readonly reason: string
}

export type ClassifiedObject = ParsedObject | RejectedObject

export const classifyObjects = (objects: readonly PolledObject[]): ClassifiedObject[] => objects.map(classifyObject)

export const parsedObjects = (classified: readonly ClassifiedObject[]): ParsedObject[] =>
  classified.filter((object): object is ParsedObject => object._tag === "ParsedObject")

export const rejectedObjects = (classified: readonly ClassifiedObject[]): RejectedObject[] =>
  classified.filter((object): object is RejectedObject => object._tag === "RejectedObject")

const classifyObject = ({ key, body }: PolledObject): ClassifiedObject =>
  Either.match(parseEventJson(body), {
    onLeft: (error): ClassifiedObject => ({ _tag: "RejectedObject", key, reason: error.message }),
    onRight: (event): ClassifiedObject => ({ _tag: "ParsedObject", key, event })
  })
