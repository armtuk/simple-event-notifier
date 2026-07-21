import type { Event } from "@personal-events/event-model"
import type { S3EventRepository } from "@personal-events/event-sink"
import type { GithubNormalizeError } from "@personal-events/github"
import type { NormalizedEvent, TransformError } from "@personal-events/integration-core"
import { Either } from "effect"
import type { Logger } from "winston"
import { partitionFresh } from "./dedupe.ts"
import type { PollResult } from "./poll-result.ts"
import { advancedCursor, type SourceState, withNotBefore } from "./poller-state.ts"
import type { GithubSourceRepository, SourceName } from "./source-repositories.ts"

/**
 * One poll cycle for one source, written **once** for both. The notifications and events cycles
 * differ in exactly three pure functions — how an item is keyed, how it is normalized, and how the
 * `since` cursor advances — so they are parameters, not two near-identical files that drift apart.
 *
 * It is **pure over the source's state**: it takes the current `SourceState` and returns the next
 * one, doing no S3 read or write of state itself. The invocation reads and writes the whole state
 * object once (`poll-once.ts`), so putting a load/save inside the cycle would break the
 * single-read/single-write property that makes one combined state object safe.
 *
 * ## The invariant that keeps events from being lost
 *
 * **The cursor and seen-set advance only after a successful write.** On a persist failure the cycle
 * returns the *unchanged* state, so the same items are re-fetched next invocation and retried. The
 * opposite order — advance the cursor, then write — turns one transient S3 error into permanently
 * missing events with a cursor claiming they were handled.
 *
 * A **malformed item** is different: it is logged with its id and skipped, and does not hold up its
 * siblings, because it will never become valid and retrying it forever would wedge the source.
 *
 * `notBefore` is how a stateless, scheduled function honours a server interval it cannot sleep for:
 * a `304`/`200` carrying `X-Poll-Interval`, or a `429`/`403` carrying `Retry-After`, records "do not
 * poll before now + that", and `poll-once.ts` skips the source until then.
 */

export interface SourceDefinition {
  readonly name: SourceName
  readonly repository: GithubSourceRepository
  readonly keyOf: (item: unknown) => string
  readonly normalize: (item: unknown) => Either.Either<NormalizedEvent, GithubNormalizeError>
  readonly toEvent: (normalized: NormalizedEvent) => Either.Either<Event, TransformError>
  /** The value to record as the next `since`, if this source supports one. */
  readonly nextSince: (items: readonly unknown[]) => string | undefined
}

export interface CycleDeps {
  readonly source: SourceDefinition
  readonly events: S3EventRepository
  readonly seenCap: number
  readonly logger: Logger
  readonly signal: AbortSignal
  /** Injected so the `notBefore` arithmetic is testable without a real clock. */
  readonly now: () => number
}

export interface CycleOutcome {
  readonly failed: boolean
  readonly written: number
}

export interface CycleResult {
  readonly next: SourceState
  readonly outcome: CycleOutcome
}

export const runSourceCycle =
  (deps: CycleDeps) =>
  async (state: SourceState): Promise<CycleResult> => {
    const result = await deps.source.repository.poll(state.cursor, deps.signal)
    const handlers: Record<PollResult["status"], () => Promise<CycleResult>> = {
      "not-modified": async (): Promise<CycleResult> => onNotModified(deps, result, state),
      "rate-limited": async (): Promise<CycleResult> => onRateLimited(deps, result, state),
      failure: async (): Promise<CycleResult> => onFailure(deps, result, state),
      items: async (): Promise<CycleResult> => onItems(deps, result, state)
    }
    return handlers[result.status]()
  }

const onNotModified = (deps: CycleDeps, result: PollResult, state: SourceState): CycleResult => {
  deps.logger.debug("nothing new", { source: deps.source.name })
  const pollIntervalMs = result.status === "not-modified" ? result.pollIntervalMs : undefined
  return { next: withNotBefore(state, deps.now(), pollIntervalMs), outcome: { failed: false, written: 0 } }
}

const onRateLimited = (deps: CycleDeps, result: PollResult, state: SourceState): CycleResult => {
  const rateLimited = result.status === "rate-limited" ? result : undefined
  deps.logger.warn("rate limited by GitHub; deferring the next poll", { source: deps.source.name, reason: rateLimited?.message })
  return { next: withNotBefore(state, deps.now(), rateLimited?.retryAfterMs), outcome: { failed: true, written: 0 } }
}

const onFailure = (deps: CycleDeps, result: PollResult, state: SourceState): CycleResult => {
  deps.logger.error("poll failed", { source: deps.source.name, reason: result.status === "failure" ? result.message : "" })
  return { next: state, outcome: { failed: true, written: 0 } }
}

const onItems = async (deps: CycleDeps, result: PollResult, state: SourceState): Promise<CycleResult> => {
  if (result.status !== "items") {
    return { next: state, outcome: { failed: true, written: 0 } }
  }
  const { fresh, nextSeen } = partitionFresh(result.items, state.seen, deps.source.keyOf, deps.seenCap)
  const events = collectEvents(deps, fresh)
  const written = await deps.events.putEvents(events)
  if (written._tag === "PutEventsFailure") {
    deps.logger.error("could not write events; NOT advancing the cursor so they are retried", {
      source: deps.source.name,
      bucket: written.bucket,
      reason: written.message
    })
    return { next: state, outcome: { failed: true, written: 0 } }
  }
  deps.logger.info("polled", { source: deps.source.name, fetched: result.items.length, fresh: fresh.length, written: written.count })
  return {
    next: withNotBefore(
      { cursor: advancedCursor(result.cursor, deps.source.nextSince(result.items)), seen: nextSeen },
      deps.now(),
      result.pollIntervalMs
    ),
    outcome: { failed: false, written: written.count }
  }
}

/**
 * Normalize + classify every fresh item, logging and dropping the ones that cannot be. A `filter`
 * over `Either`s rather than a loop with a `push`, and the failures are reported individually so the
 * log names *which* item was skipped and why.
 */
const collectEvents = (deps: CycleDeps, fresh: readonly unknown[]): readonly Event[] => {
  const results = fresh.map(item => toEventOrReason(deps, item))
  results.filter(Either.isLeft).forEach(failure => {
    deps.logger.warn("skipping unprocessable item", { source: deps.source.name, ...failure.left })
  })
  return results.filter(Either.isRight).map(success => success.right)
}

interface SkipReason {
  readonly itemId: string
  readonly reason: string
}

const toEventOrReason = (deps: CycleDeps, item: unknown): Either.Either<Event, SkipReason> =>
  Either.mapLeft(Either.flatMap(deps.source.normalize(item), deps.source.toEvent), failure =>
    failure._tag === "GithubNormalizeError"
      ? { itemId: failure.itemId, reason: failure.reason }
      : { itemId: deps.source.keyOf(item), reason: failure.reason }
  )
