import { describeCause } from "@personal-events/event-model"
import type { Logger } from "winston"
import { nextDelayMs } from "./backoff.ts"
import type { CycleOutcome } from "./source-cycle.ts"

/**
 * The loop mechanics, and nothing else — no GitHub, no S3, no knowledge of what a cycle does.
 *
 * **Self-scheduling `setTimeout`, not `setInterval`**: a cycle that outruns its interval would
 * otherwise overlap itself, and the next delay depends on what the last cycle learned
 * (`X-Poll-Interval`, `Retry-After`, the failure count).
 *
 * **The next tick is scheduled from a timer callback and the previous promise is discarded**, rather
 * than `return tick()` from an `async` function. A recursive `await` chain means the first promise
 * cannot settle until the last one does, so pending promise objects and their reaction records
 * accumulate for the life of the process — measured at ~97 bytes/tick, linear and unbounded. See
 * `CLAUDE.md` § "A long-running loop must not chain each iteration's promise to the next" and
 * `apps/desktop-notifier/src/daemon.ts`.
 *
 * Each source runs its own loop, so a source that is failing, throttled, or has no token cannot stop
 * the other — the whole point of the dual-path design.
 */

export type ScheduleTick = (run: () => void, delayMs: number) => void

export interface SourcePollerOptions {
  readonly name: string
  readonly baseIntervalMs: number
  readonly maxBackoffMs: number
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly runCycle: () => Promise<CycleOutcome>
  /** Injected so a spec can drive the schedule deterministically. */
  readonly schedule?: ScheduleTick
}

export interface RunningSourcePoller {
  readonly name: string
  /** Consecutive failures; the exponent in the back-off. Reset by any successful cycle. */
  readonly attempts: () => number
}

/**
 * A **ref'd** timer, and one that is **cancelled on abort**. Both halves were found by running the
 * built binary rather than by a spec, and each is a real failure the other does not cover:
 *
 * - An `unref()`'d timer lets Node exit as soon as the only remaining handle is the next scheduled
 *   poll — which *is* the steady state of an idle poller. The service would run one cycle per
 *   container and then quietly stop, looking like success in the logs: a clean startup, one poll, no
 *   error. So the timer is ref'd, and it is what keeps the process alive between polls.
 * - A ref'd timer that is not cancelled then keeps the process alive **after** shutdown, until the
 *   pending delay elapses. With back-off that can be `maxBackoffMs` — fifteen minutes by default —
 *   so Railway would `SIGKILL` a service that was trying to exit politely. Aborting clears it.
 */
const cancellableSchedule = (signal: AbortSignal): ScheduleTick => {
  let pending: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener("abort", () => clearTimeout(pending), { once: true })
  return (run: () => void, delayMs: number): void => {
    pending = setTimeout(run, delayMs)
  }
}

export const runSourcePoller = (options: SourcePollerOptions): RunningSourcePoller => {
  const schedule = options.schedule ?? cancellableSchedule(options.signal)
  let attempt = 0

  const tick = async (): Promise<void> => {
    if (options.signal.aborted) {
      return
    }
    const outcome = await options.runCycle().catch((cause: unknown): CycleOutcome => {
      options.logger.error("cycle threw", { source: options.name, reason: describeCause(cause) })
      return { failed: true, written: 0 }
    })
    attempt = outcome.failed ? attempt + 1 : 0
    if (options.signal.aborted) {
      return
    }
    schedule(
      () => void tick(),
      nextDelayMs({
        attempt,
        baseIntervalMs: options.baseIntervalMs,
        maxBackoffMs: options.maxBackoffMs,
        ...(outcome.pollIntervalMs === undefined ? {} : { pollIntervalMs: outcome.pollIntervalMs }),
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs })
      })
    )
  }

  void tick()
  return { name: options.name, attempts: (): number => attempt }
}
