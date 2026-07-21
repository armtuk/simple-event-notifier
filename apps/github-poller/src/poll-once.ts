import type { S3EventRepository } from "@personal-events/event-sink"
import type { Logger } from "winston"
import { isDue, type PollerState, stateFor, withSourceState } from "./poller-state.ts"
import type { PollerStateRepository } from "./poller-state-repository.ts"
import { runSourceCycle, type SourceDefinition } from "./source-cycle.ts"

/**
 * One scheduled invocation: load the whole state object **once**, poll each runnable source in turn,
 * write the whole object **once**. That single-read/single-write shape is what lets a single combined
 * state object be correct (see `poller-state.ts`), and it is the entire cycle — there is no loop,
 * because EventBridge is the loop.
 *
 * State is threaded through `reduce` rather than a mutable accumulator, so the sources run strictly
 * sequentially and each sees the branch the previous step left. A source whose `notBefore` has not
 * elapsed is skipped (GitHub asked us to wait), leaving its branch untouched.
 *
 * `sources` are already the **runnable** ones: `composition.ts` has resolved each configured
 * source's token from SSM and dropped any it could not. So a token that failed to read disables its
 * own source for this invocation and no other.
 */

export interface PollOnceDeps {
  readonly state: PollerStateRepository
  readonly sources: readonly SourceDefinition[]
  readonly events: S3EventRepository
  readonly seenCap: number
  readonly logger: Logger
  readonly signal: AbortSignal
  readonly now: () => number
}

export interface PollSummary {
  readonly written: number
  readonly polled: readonly string[]
  readonly skipped: readonly string[]
}

interface PollProgress {
  readonly state: PollerState
  readonly written: number
  readonly polled: readonly string[]
  readonly skipped: readonly string[]
}

export const pollOnce = async (deps: PollOnceDeps): Promise<PollSummary> => {
  const loaded = await deps.state.load()
  const nowMs = deps.now()
  const progress = await deps.sources.reduce<Promise<PollProgress>>(
    async (accP, source) => stepSource(deps, nowMs, await accP, source),
    Promise.resolve({ state: loaded, written: 0, polled: [], skipped: [] })
  )
  await deps.state.save(progress.state)
  deps.logger.info("poll complete", { written: progress.written, polled: progress.polled, skipped: progress.skipped })
  return { written: progress.written, polled: progress.polled, skipped: progress.skipped }
}

const stepSource = async (deps: PollOnceDeps, nowMs: number, acc: PollProgress, source: SourceDefinition): Promise<PollProgress> => {
  const branch = stateFor(acc.state, source.name)
  if (!isDue(branch, nowMs)) {
    deps.logger.debug("source not due yet; skipping this tick", { source: source.name, notBefore: branch.notBefore })
    return { ...acc, skipped: [...acc.skipped, source.name] }
  }
  const { next, outcome } = await runSourceCycle({
    source,
    events: deps.events,
    seenCap: deps.seenCap,
    logger: deps.logger,
    signal: deps.signal,
    now: deps.now
  })(branch)
  return {
    state: withSourceState(acc.state, source.name, next),
    written: acc.written + outcome.written,
    polled: [...acc.polled, source.name],
    skipped: acc.skipped
  }
}
