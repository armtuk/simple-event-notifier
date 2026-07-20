import type { Event } from "@personal-events/event-model"
import type { S3EventRepository } from "@personal-events/event-sink"
import type { GithubNormalizeError } from "@personal-events/github"
import type { NormalizedEvent, TransformError } from "@personal-events/integration-core"
import { Either } from "effect"
import type { Logger } from "winston"
import { partitionFresh } from "./dedupe.ts"
import type { PollResult } from "./poll-result.ts"
import { advancedCursor, stateFor, withSourceState } from "./poller-state.ts"
import type { PollerStateRepository } from "./poller-state-repository.ts"
import type { GithubSourceRepository, SourceName } from "./source-repositories.ts"

/**
 * One poll cycle, written **once** for both sources. The notifications and events cycles differ in
 * exactly three pure functions — how an item is keyed, how it is normalized, and how the `since`
 * cursor advances — so they are parameters, not two near-identical files that drift apart.
 *
 * Gather (load state, conditional GET) → Compute (dedupe, normalize, classify) → Persist (write
 * events, then save state), with the phases in separate collaborators.
 *
 * ## The invariant that keeps events from being lost
 *
 * **State advances only after a successful write.** A persist failure returns without saving, so the
 * same items are re-fetched next cycle and retried. The opposite order — save the cursor, then
 * write — turns one transient S3 error into permanently missing events, with a cursor claiming they
 * were handled.
 *
 * A **malformed item** is different: it is logged with its id and skipped, and does *not* hold up
 * its siblings, because it will never become valid and retrying it forever would wedge the source.
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
  readonly state: PollerStateRepository
  readonly events: S3EventRepository
  readonly seenCap: number
  readonly logger: Logger
  readonly signal: AbortSignal
}

export interface CycleOutcome {
  readonly pollIntervalMs?: number
  readonly retryAfterMs?: number
  readonly failed: boolean
  readonly written: number
}

export const runSourceCycle = (deps: CycleDeps) => async (): Promise<CycleOutcome> => {
  const state = await deps.state.load()
  const result = await deps.source.repository.poll(stateFor(state, deps.source.name).cursor, deps.signal)
  const handlers: Record<PollResult["status"], () => Promise<CycleOutcome>> = {
    "not-modified": async (): Promise<CycleOutcome> => onNotModified(deps, result),
    "rate-limited": async (): Promise<CycleOutcome> => onRateLimited(deps, result),
    failure: async (): Promise<CycleOutcome> => onFailure(deps, result),
    items: async (): Promise<CycleOutcome> => onItems(deps, result, state)
  }
  return handlers[result.status]()
}

const onNotModified = (deps: CycleDeps, result: PollResult): CycleOutcome => {
  deps.logger.debug("nothing new", { source: deps.source.name })
  return { failed: false, written: 0, ...(result.status === "not-modified" ? optional("pollIntervalMs", result.pollIntervalMs) : {}) }
}

const onRateLimited = (deps: CycleDeps, result: PollResult): CycleOutcome => {
  const rateLimited = result.status === "rate-limited" ? result : undefined
  deps.logger.warn("rate limited by GitHub; backing off", { source: deps.source.name, reason: rateLimited?.message })
  return { failed: true, written: 0, ...optional("retryAfterMs", rateLimited?.retryAfterMs) }
}

const onFailure = (deps: CycleDeps, result: PollResult): CycleOutcome => {
  deps.logger.error("poll failed", { source: deps.source.name, reason: result.status === "failure" ? result.message : "" })
  return { failed: true, written: 0 }
}

const onItems = async (
  deps: CycleDeps,
  result: PollResult,
  state: Awaited<ReturnType<PollerStateRepository["load"]>>
): Promise<CycleOutcome> => {
  if (result.status !== "items") {
    return { failed: true, written: 0 }
  }
  const sourceState = stateFor(state, deps.source.name)
  const { fresh, nextSeen } = partitionFresh(result.items, sourceState.seen, deps.source.keyOf, deps.seenCap)
  const events = collectEvents(deps, fresh)
  const written = await deps.events.putEvents(events)
  if (written._tag === "PutEventsFailure") {
    deps.logger.error("could not write events; NOT advancing the cursor so they are retried", {
      source: deps.source.name,
      bucket: written.bucket,
      reason: written.message
    })
    return { failed: true, written: 0 }
  }
  await deps.state.save(
    withSourceState(state, deps.source.name, { cursor: advancedCursor(result.cursor, deps.source.nextSince(result.items)), seen: nextSeen })
  )
  deps.logger.info("polled", { source: deps.source.name, fetched: result.items.length, fresh: fresh.length, written: written.count })
  return { failed: false, written: written.count, ...optional("pollIntervalMs", result.pollIntervalMs) }
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

/** `exactOptionalPropertyTypes`: build the key only when there is a value for it. */
const optional = <K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, number>)
