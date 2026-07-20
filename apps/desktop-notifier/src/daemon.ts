import type { S3Client } from "@aws-sdk/client-s3"
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

export const runDaemon = async (
  dependencies: DaemonDependencies,
  schedule: DaemonSchedule,
  initial: TickState,
  signal: AbortSignal
): Promise<TickState> => {
  if (signal.aborted) {
    return initial
  }
  const next = await runTick(dependencies, initial)
  await delay(nextDelayMs(schedule, next.consecutiveErrors), signal)
  return signal.aborted ? next : runDaemon(dependencies, schedule, next, signal)
}

export const runTick = async (dependencies: DaemonDependencies, state: TickState): Promise<TickState> => {
  const { s3, bucket, logger, stateFile } = dependencies
  return pollOnce(s3, bucket, state.mark)
    .then(async ({ objects, mark }): Promise<TickState> => {
      const classified = classifyObjects(objects)
      rejectedObjects(classified).forEach(({ key, reason }): void => {
        logger.warn("Skipping unparseable event object", { key, reason })
      })
      await deliverAll(dependencies, parsedObjects(classified))
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

/** Notifications are raised strictly in key order — the promise chain is the accumulator, threaded through reduce. */
const deliverAll = async (dependencies: DaemonDependencies, parsed: readonly ParsedObject[]): Promise<void> =>
  parsed.reduce(async (chain, object) => chain.then(async () => deliverOne(dependencies, object)), Promise.resolve())

const deliverOne = async ({ notifier, logger }: DaemonDependencies, { key, event }: ParsedObject): Promise<void> => {
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

const delay = async (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
