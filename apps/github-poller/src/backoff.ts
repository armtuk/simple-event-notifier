/**
 * How long to wait before the next poll of a source. Pure — a function of the attempt count and
 * whatever the server asked for — so the schedule is assertable without waiting for it.
 *
 * The rule is **the largest of everything anyone asked for**, capped:
 *
 * - the configured base interval,
 * - `X-Poll-Interval`, which GitHub raises under load and a client is expected to obey,
 * - `Retry-After` (or the time until `X-RateLimit-Reset`) when throttled,
 * - exponential back-off over consecutive failures.
 *
 * Taking the maximum rather than a priority order means no signal can be accidentally suppressed by
 * another: a server asking for 300 s while the poller is also in back-off waits 300 s, not 2 s.
 *
 * Jitter (±25%) is applied last so that a restart of both source loops at once does not lock them
 * into lockstep bursts, mirroring the desktop notifier's daemon.
 */

export interface DelayInputs {
  readonly attempt: number
  readonly baseIntervalMs: number
  readonly maxBackoffMs: number
  readonly pollIntervalMs?: number
  readonly retryAfterMs?: number
}

export const jitterFraction = 0.25

export const nextDelayMs = (inputs: DelayInputs, randomFraction: number = Math.random()): number => {
  const floor = Math.max(inputs.baseIntervalMs, inputs.pollIntervalMs ?? 0, inputs.retryAfterMs ?? 0, backoffMs(inputs))
  return Math.round(withJitter(Math.min(floor, ceilingFor(inputs)), randomFraction))
}

/**
 * The ceiling never suppresses an explicit server instruction. If GitHub says "come back in an
 * hour" and the configured cap is fifteen minutes, waiting fifteen minutes is disobeying the API,
 * not being responsive.
 */
const ceilingFor = (inputs: DelayInputs): number => Math.max(inputs.maxBackoffMs, inputs.pollIntervalMs ?? 0, inputs.retryAfterMs ?? 0)

const backoffMs = (inputs: DelayInputs): number =>
  inputs.attempt <= 0 ? 0 : Math.min(inputs.baseIntervalMs * 2 ** Math.min(inputs.attempt, 16), inputs.maxBackoffMs)

const withJitter = (delayMs: number, randomFraction: number): number => delayMs * (1 + jitterFraction * (2 * randomFraction - 1))
