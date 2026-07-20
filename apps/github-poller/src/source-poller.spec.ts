import { describe, expect, it } from "vitest"
import type { CycleOutcome } from "./source-cycle.ts"
import { runSourcePoller } from "./source-poller.ts"
import { capturingLogger, entriesFor } from "./testing/poller-fixtures.ts"

/**
 * The loop is driven through an injected scheduler rather than real timers: a spec that waits for a
 * 60-second interval is a spec nobody runs. Every tick is explicit, so the schedule itself — the
 * thing this module exists to get right — is what gets asserted.
 */
const drivenPoller = (outcomes: readonly CycleOutcome[], ticks: number) => {
  const log = capturingLogger()
  const controller = new AbortController()
  const delays: number[] = []
  const pending: (() => void)[] = []
  let cycles = 0

  const poller = runSourcePoller({
    name: "notifications",
    baseIntervalMs: 60_000,
    maxBackoffMs: 900_000,
    signal: controller.signal,
    logger: log.logger,
    runCycle: async (): Promise<CycleOutcome> => {
      const outcome = outcomes[Math.min(cycles, outcomes.length - 1)] ?? { failed: false, written: 0 }
      cycles += 1
      return outcome
    },
    schedule: (run, delayMs): void => {
      delays.push(delayMs)
      pending.push(run)
    }
  })

  const advance = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    const next = pending.shift()
    next?.()
  }

  return { poller, controller, delays, log, cycles: (): number => cycles, advance, ticks }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("runSourcePoller", () => {
  it("runs a first cycle immediately rather than waiting an interval", async () => {
    const driven = drivenPoller([{ failed: false, written: 1 }], 1)
    await settle()
    expect(driven.cycles()).toBe(1)
  })

  it("schedules the next tick after each cycle, and runs it when the timer fires", async () => {
    const driven = drivenPoller([{ failed: false, written: 0 }], 2)
    await settle()
    await driven.advance()
    await settle()
    expect(driven.cycles()).toBe(2)
  })

  it("resets the failure count after a success, so back-off does not persist", async () => {
    const driven = drivenPoller(
      [
        { failed: true, written: 0 },
        { failed: false, written: 0 }
      ],
      2
    )
    await settle()
    expect(driven.poller.attempts()).toBe(1)
    await driven.advance()
    await settle()
    expect(driven.poller.attempts()).toBe(0)
  })

  it("counts consecutive failures, which is what makes the delay grow", async () => {
    const driven = drivenPoller([{ failed: true, written: 0 }], 3)
    await settle()
    await driven.advance()
    await settle()
    expect(driven.poller.attempts()).toBe(2)
    expect(driven.delays[1]).toBeGreaterThan(driven.delays[0] ?? 0)
  })

  it("honours a poll interval the cycle reported", async () => {
    const driven = drivenPoller([{ failed: false, written: 0, pollIntervalMs: 600_000 }], 1)
    await settle()
    expect(driven.delays[0]).toBeGreaterThanOrEqual(450_000)
  })

  it("honours a retry-after the cycle reported", async () => {
    const driven = drivenPoller([{ failed: true, written: 0, retryAfterMs: 1_800_000 }], 1)
    await settle()
    expect(driven.delays[0]).toBeGreaterThanOrEqual(1_350_000)
  })

  it("schedules nothing more once aborted", async () => {
    const driven = drivenPoller([{ failed: false, written: 0 }], 1)
    await settle()
    const scheduled = driven.delays.length
    driven.controller.abort()
    await driven.advance()
    await settle()
    expect(driven.delays).toHaveLength(scheduled)
  })

  it("does not start a cycle at all when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const log = capturingLogger()
    let cycles = 0
    runSourcePoller({
      name: "events",
      baseIntervalMs: 1000,
      maxBackoffMs: 1000,
      signal: controller.signal,
      logger: log.logger,
      runCycle: async () => {
        cycles += 1
        return { failed: false, written: 0 }
      },
      schedule: (): void => {}
    })
    await settle()
    expect(cycles).toBe(0)
  })

  it("survives a cycle that throws, treating it as a failure rather than killing the loop", async () => {
    const log = capturingLogger()
    const controller = new AbortController()
    const delays: number[] = []
    const poller = runSourcePoller({
      name: "notifications",
      baseIntervalMs: 60_000,
      maxBackoffMs: 900_000,
      signal: controller.signal,
      logger: log.logger,
      runCycle: async () => Promise.reject(new Error("state bucket unreachable")),
      schedule: (_run, delayMs): void => void delays.push(delayMs)
    })
    await settle()
    expect(poller.attempts()).toBe(1)
    expect(delays).toHaveLength(1)
    expect(entriesFor(log.captured, "cycle threw")[0]).toMatchObject({ level: "error", reason: "state bucket unreachable" })
  })
})
