import { Either, ParseResult, Schema } from "effect"
import type { SourceCursor } from "./poll-result.ts"
import { type SourceName, sourceNames } from "./source-repositories.ts"

/**
 * The poller's memory across restarts and redeploys: per source, the conditional-request cursor and
 * the bounded set of item keys already written.
 *
 * It is a **schema**, not a plain interface, because it is read back from an object an operator (or
 * a previous version of this code) may have written. A state file that fails to decode is recovered
 * from — starting empty — rather than crashing the process, but the recovery has to be able to tell
 * "malformed" from "valid" to do that, and only a schema can.
 */

const SourceCursorSchema = /*#__PURE__*/ Schema.Struct({
  lastModified: Schema.optionalWith(Schema.String, { exact: true }),
  etag: Schema.optionalWith(Schema.String, { exact: true }),
  since: Schema.optionalWith(Schema.String, { exact: true })
}).annotations({ identifier: "SourceCursor" })

const SourceStateSchema = /*#__PURE__*/ Schema.Struct({ cursor: SourceCursorSchema, seen: Schema.Array(Schema.String) }).annotations({
  identifier: "SourceState"
})

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

/**
 * A whole-state update from one source's result. Written as a replace-one-branch merge so the two
 * source loops, which run concurrently, cannot clobber each other's cursor through a stale read of
 * the sibling's branch.
 */
export const withSourceState = (state: PollerState, source: SourceName, next: SourceState): PollerState =>
  source === sourceNames.notifications ? { ...state, notifications: next } : { ...state, events: next }

export const advancedCursor = (cursor: SourceCursor, since: string | undefined): SourceCursor =>
  since === undefined ? cursor : { ...cursor, since }

const decodeState = /*#__PURE__*/ Schema.decodeUnknownEither(PollerStateSchema, { errors: "all" })
