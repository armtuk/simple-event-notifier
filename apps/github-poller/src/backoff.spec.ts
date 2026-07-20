import { describe, expect, it } from "vitest"
import { nextDelayMs } from "./backoff.ts"

/** `randomFraction: 0.5` is the midpoint, so jitter contributes exactly zero and the arithmetic is exact. */
const noJitter = 0.5

const base = { attempt: 0, baseIntervalMs: 60_000, maxBackoffMs: 900_000 }

describe("nextDelayMs", () => {
  it("waits the configured interval when nothing else asks for longer", () => {
    expect(nextDelayMs(base, noJitter)).toBe(60_000)
  })

  it("honours X-Poll-Interval when GitHub asks for longer than the configured interval", () => {
    expect(nextDelayMs({ ...base, pollIntervalMs: 120_000 }, noJitter)).toBe(120_000)
  })

  it("ignores an X-Poll-Interval shorter than the configured interval — polling faster is our choice, not GitHub's", () => {
    expect(nextDelayMs({ ...base, pollIntervalMs: 10_000 }, noJitter)).toBe(60_000)
  })

  it("honours Retry-After", () => {
    expect(nextDelayMs({ ...base, retryAfterMs: 300_000 }, noJitter)).toBe(300_000)
  })

  it("grows exponentially over consecutive failures", () => {
    expect(nextDelayMs({ ...base, attempt: 1 }, noJitter)).toBe(120_000)
    expect(nextDelayMs({ ...base, attempt: 2 }, noJitter)).toBe(240_000)
    expect(nextDelayMs({ ...base, attempt: 3 }, noJitter)).toBe(480_000)
  })

  it("caps back-off at the configured ceiling rather than growing without bound", () => {
    expect(nextDelayMs({ ...base, attempt: 40 }, noJitter)).toBe(900_000)
  })

  it("takes the LARGEST signal, so back-off cannot suppress a server instruction or vice versa", () => {
    expect(nextDelayMs({ ...base, attempt: 1, pollIntervalMs: 300_000 }, noJitter)).toBe(300_000)
    expect(nextDelayMs({ ...base, attempt: 4, pollIntervalMs: 90_000 }, noJitter)).toBe(900_000)
  })

  it("obeys a Retry-After longer than the ceiling — waiting less would be disobeying the API", () => {
    expect(nextDelayMs({ ...base, retryAfterMs: 3_600_000 }, noJitter)).toBe(3_600_000)
  })

  it("resets to the base interval once a cycle succeeds", () => {
    expect(nextDelayMs({ ...base, attempt: 0 }, noJitter)).toBe(60_000)
  })

  it("applies at most ±25% jitter, so two loops restarted together do not stay in lockstep", () => {
    expect(nextDelayMs(base, 0)).toBe(45_000)
    expect(nextDelayMs(base, 1)).toBe(75_000)
  })

  it("never returns a negative or fractional delay", () => {
    const delays = [0, 0.1, 0.5, 0.9, 1].map(fraction => nextDelayMs({ ...base, attempt: 3 }, fraction))
    expect(delays.filter(delay => delay < 0 || !Number.isInteger(delay))).toStrictEqual([])
  })
})
