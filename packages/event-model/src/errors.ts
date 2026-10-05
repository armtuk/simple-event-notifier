/**
 * The failure channel of the event-model contract. Every decode entry point returns
 * `Either<A, EventModelError>` rather than throwing, so callers can branch on `reason`
 * and log a message that names both the offending input and what was wrong with it.
 */

export const eventModelErrorReasons = {
  invalidEvent: "invalidEvent",
  invalidEventJson: "invalidEventJson",
  invalidEventKey: "invalidEventKey"
} as const

export type EventModelErrorReason = (typeof eventModelErrorReasons)[keyof typeof eventModelErrorReasons]

export interface EventModelError {
  readonly _tag: "EventModelError"
  readonly reason: EventModelErrorReason
  readonly message: string
}

export const eventModelError = (reason: EventModelErrorReason, message: string): EventModelError => ({
  _tag: "EventModelError",
  reason,
  message
})
