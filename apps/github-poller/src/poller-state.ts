import { Either, ParseResult, Schema } from "effect"
import type { SourceCursor } from "./poll-result.ts"
import { type SourceName, sourceNames } from "./source-repositories.ts"

/**
 * The poller's memory across invocations: per source, the conditional-request cursor, the bounded
 * set of item keys already written, and an optional `notBefore` instant that honours GitHub's
 * `X-Poll-Interval` / `Retry-After` in a stateless world.
 *
 * It is a **schema**, not a plain interface, because it is read back from an object an operator — or
 * a previous version of this code — may have written. A state object that fails to decode is
 * recovered from by starting empty rather than by crashing, and only a schema can tell "malformed"
 * from "valid" well enough to do that.
 *
 * ## Why one combined object is safe here
 *
 * A single object holding both sources' branches would be a lost-update hazard **if** two workers
 * read-modify-wrote it concurrently. This poller is a **scheduled Lambda that reads the object once
 * at the start of an invocation and writes it once at the end**, polling both sources sequentially
 * in between — so within an invocation there is no concurrency at all. Across invocations, the
 * EventBridge rule fires once a minute and the function is deployed with
 * `reserved_concurrent_executions = 1` (see `infra/personal-events/github-poller.tf`), so two
 * invocations can never overlap. That is what makes the combined object correct, and it is why the
 * earlier long-running-daemon design — which ran two concurrent loops against one object and *did*
 * have the lost update the R1 review found — is gone.
 */

const SourceCursorSchema = /*#__PURE__*/ Schema.Struct({
  lastModified: Schema.optionalWith(Schema.String, { exact: true }),
  etag: Schema.optionalWith(Schema.String, { exact: true }),
  since: Schema.optionalWith(Schema.String, { exact: true })
}).annotations({ identifier: "SourceCursor" })

export const SourceStateSchema = /*#__PURE__*/ Schema.Struct({
  cursor: SourceCursorSchema,
  seen: Schema.Array(Schema.String),
  /** ISO instant: skip polling this source until now passes it. Set from `X-Poll-Interval` / `Retry-After`. */
  notBefore: Schema.optionalWith(Schema.String, { exact: true })
}).annotations({ identifier: "SourceState" })

export type SourceState = typeof SourceStateSchema.Type

export const PollerStateSchema = /*#__PURE__*/ Schema.Struct({ notifications: SourceStateSchema, events: SourceStateSchema }).annotations({
  identifier: "PollerState"
})

export type PollerState = typeof PollerStateSchema.Type

export const emptySourceState: SourceState = { cursor: {}, seen: [] }

export const emptyPollerState: PollerState = { notifications: emptySourceState, events: emptySourceState }

export const decodePollerState = (raw: unknown): Either.Either<PollerState, string> =>
  Either.mapLeft(decodeState(raw), error => ParseResult.TreeFormatter.formatErrorSync(error))

export const stateFor = (state: PollerState, source: SourceName): SourceState =>
  source === sourceNames.notifications ? state.notifications : state.events

export const withSourceState = (state: PollerState, source: SourceName, next: SourceState): PollerState =>
  source === sourceNames.notifications ? { ...state, notifications: next } : { ...state, events: next }

export const advancedCursor = (cursor: SourceCursor, since: string | undefined): SourceCursor =>
  since === undefined ? cursor : { ...cursor, since }

/** A source is due when it has no `notBefore`, or that instant has passed. */
export const isDue = (state: SourceState, nowMs: number): boolean => state.notBefore === undefined || Date.parse(state.notBefore) <= nowMs

/** Records "do not poll again before now + `delayMs`", so a scheduled Lambda can honour a server interval it cannot sleep for. */
export const withNotBefore = (state: SourceState, nowMs: number, delayMs: number | undefined): SourceState =>
  delayMs === undefined || delayMs <= 0 ? withoutNotBefore(state) : { ...state, notBefore: new Date(nowMs + delayMs).toISOString() }

const withoutNotBefore = (state: SourceState): SourceState => {
  const { notBefore: _dropped, ...rest } = state
  return rest
}

const decodeState = /*#__PURE__*/ Schema.decodeUnknownEither(PollerStateSchema, { errors: "all" })
