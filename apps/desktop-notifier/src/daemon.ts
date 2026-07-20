import type { S3Client } from "@aws-sdk/client-s3"
import { describeCause } from "@personal-events/event-model"
import type { Logger } from "winston"
import { classifyObjects, type ParsedObject, parsedObjects, rejectedObjects } from "./classify.ts"
import { toNotification } from "./notification-content.ts"
import type { NotifierAdapter } from "./notify.ts"
import { pollOnce } from "./poller.ts"
import { saveState } from "./state.ts"

/**
 * The loop that wires Gather (`poller`) → Compute (`classify`, `notification-content`) → Persist
 * (`notify`, `state`). Ticks are self-scheduling rather than `setInterval`, so a slow poll can
 * never overlap the next one, and a failing tick backs off instead of hammering S3.
 */

export interface DaemonDependencies {
  readonly s3: S3Client
  readonly bucket: string
  readonly notifier: NotifierAdapter
  readonly logger: Logger
  readonly stateFile: string
}

export interface DaemonSchedule {
  readonly pollIntervalMs: number
  readonly maxBackoffMs: number
}

export interface TickState {
  readonly mark: string
  readonly consecutiveErrors: number
}

/**
 * Runs ticks until the signal aborts, scheduling each one from inside the previous tick's timer
 * callback.
 *
 * The scheduling shape matters for a process meant to run for weeks. `await`ing a recursive call
 * would chain every tick's promise to the next — the first tick's promise could not settle until
 * the last one did — so one pending promise and one async frame (each closing over the whole
 * dependency set) would be retained per tick, forever. Discarding each tick's promise instead lets
 * every frame unwind, and the loop's only live state is `state` and one timer handle.
 */
export const runDaemon = async (
  dependencies: DaemonDependencies,
  schedule: DaemonSchedule,
  initial: TickState,
  signal: AbortSignal
): Promise<TickState> =>
  new Promise<TickState>(resolve => {
    let state = initial
    let ticking = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const stop = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(state)
    }

    /**
     * Aborting between ticks stops immediately; aborting *during* a tick lets that tick run to
     * completion — it still has notifications to raise and a mark to persist, and cutting it short
     * would re-deliver those events on the next start. The tick's own continuation sees the
     * aborted signal and stops there instead.
     */
    const onAbort = (): void => {
      if (!ticking) {
        stop()
      }
    }

    const tick = (): void => {
      ticking = true
      void runTick(dependencies, state)
        .catch((): TickState => ({ mark: state.mark, consecutiveErrors: state.consecutiveErrors + 1 }))
        .then(next => {
          ticking = false
          state = next
          if (signal.aborted) {
            stop()
          } else {
            timer = setTimeout(tick, nextDelayMs(schedule, state.consecutiveErrors))
          }
        })
    }

    if (signal.aborted) {
      resolve(state)
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    tick()
  })

export const runTick = async (dependencies: DaemonDependencies, state: TickState): Promise<TickState> => {
  const { s3, bucket, logger, stateFile } = dependencies
  return pollOnce(s3, bucket, state.mark)
    .then(async ({ objects, mark }): Promise<TickState> => {
      const classified = classifyObjects(objects)
      rejectedObjects(classified).forEach(({ key, reason }): void => {
        logger.warn("Skipping unparseable event object", { key, reason })
      })
      await deliverAll({ notifier: dependencies.notifier, logger }, parsedObjects(classified))
      await advance(logger, stateFile, state.mark, mark)
      return { mark, consecutiveErrors: 0 }
    })
    .catch((cause: unknown): TickState => {
      logger.error("Poll failed; backing off before the next attempt", { bucket, mark: state.mark, reason: describeCause(cause) })
      return { mark: state.mark, consecutiveErrors: state.consecutiveErrors + 1 }
    })
}

/** Exponential backoff with +/-25% jitter so several restarted clients do not resynchronize onto the same tick. */
export const nextDelayMs = (
  { pollIntervalMs, maxBackoffMs }: DaemonSchedule,
  consecutiveErrors: number,
  random: () => number = Math.random
): number =>
  consecutiveErrors === 0
    ? pollIntervalMs
    : Math.round(Math.min(pollIntervalMs * 2 ** consecutiveErrors, maxBackoffMs) * (0.75 + random() * 0.5))

/**
 * Delivery needs exactly two of the daemon's dependencies. Naming that slice keeps `s3`, `bucket`
 * and `stateFile` out of reach here — destructuring in the signature narrows the *binding*, not the
 * parameter type, so a later edit could otherwise quietly reach for the rest of the aggregate.
 */
export interface Delivery {
  readonly notifier: NotifierAdapter
  readonly logger: Logger
}

/** Notifications are raised strictly in key order — the promise chain is the accumulator, threaded through reduce. */
const deliverAll = async (delivery: Delivery, parsed: readonly ParsedObject[]): Promise<void> =>
  parsed.reduce(async (chain, object) => chain.then(async () => deliverOne(delivery, object)), Promise.resolve())

const deliverOne = async ({ notifier, logger }: Delivery, { key, event }: ParsedObject): Promise<void> => {
  const result = await notifier.notify(toNotification(event))
  const logged = { key, source: event.source, name: event.name, priority: event.priority, eventType: event.eventType }
  if (result._tag === "NotifySuccess") {
    logger.info("Raised desktop notification", logged)
  } else {
    logger.error("Could not raise desktop notification", { ...logged, notifier: notifier.name, reason: result.message })
  }
}

const advance = async (logger: Logger, stateFile: string, previous: string, next: string): Promise<void> =>
  next === previous
    ? undefined
    : saveState(stateFile, { mark: next }).catch((cause: unknown) => {
        logger.error("Could not persist the high-water mark; events may be re-notified after a restart", {
          stateFile,
          mark: next,
          reason: describeCause(cause)
        })
      })
