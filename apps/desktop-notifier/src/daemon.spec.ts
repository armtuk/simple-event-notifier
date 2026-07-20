import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type DaemonDependencies, nextDelayMs, runDaemon, runTick } from "./daemon.ts"
import type { DesktopNotification } from "./notification-content.ts"
import type { NotifierAdapter, NotifyResult } from "./notify.ts"
import { loadState } from "./state.ts"
import { type CapturedLog, capturingLogger, entriesFor } from "./testing/capture-logger.ts"
import { readExemplarText } from "./testing/exemplars.ts"
import { createFakeS3 } from "./testing/fake-s3.ts"

const goodKey = "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json"
const laterKey = "2026-06-28T18:44:32.000Z.notification.p8.claude-code.prompt-complete.json"
const badKey = "2026-06-28T18:44:31.000Z.alert.p9.github.new-pull-request.json"

const bucketObjects: Readonly<Record<string, string>> = {
  [goodKey]: readExemplarText("valid-github-pull-request.json"),
  [badKey]: readExemplarText("invalid-priority-out-of-range.json"),
  [laterKey]: readExemplarText("valid-agent-notification.json")
}

const recordingNotifier = (raised: DesktopNotification[]): NotifierAdapter => ({
  name: "recording",
  notify: async (notification): Promise<NotifyResult> => {
    raised.push(notification)
    return { _tag: "NotifySuccess" }
  }
})

const failingNotifier = (message: string): NotifierAdapter => ({
  name: "failing",
  notify: async (): Promise<NotifyResult> => ({ _tag: "NotifyFailure", message })
})

let directory = ""
let captured: CapturedLog[] = []

const stateFile = (): string => join(directory, "state.json")

const dependenciesFor = (
  raised: DesktopNotification[],
  objects = bucketObjects,
  pageSize = 1000,
  notifier?: NotifierAdapter
): DaemonDependencies => {
  const capturing = capturingLogger()
  captured = capturing.captured
  return {
    s3: createFakeS3({ objects, pageSize }).client,
    bucket: "events.test.personal-events.example.com",
    notifier: notifier ?? recordingNotifier(raised),
    logger: capturing.logger,
    stateFile: stateFile()
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-events-daemon-"))
  captured = []
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("runTick", () => {
  it("notifies for every parseable event after the mark, in key order", async () => {
    const raised: DesktopNotification[] = []
    await runTick(dependenciesFor(raised), { mark: "", consecutiveErrors: 0 })
    expect(raised.map(notification => notification.title)).toStrictEqual(["Alert p5 · github", "Notification p8 · claude-code"])
  })

  it("skips the malformed object without blocking the events behind it", async () => {
    const raised: DesktopNotification[] = []
    await runTick(dependenciesFor(raised), { mark: "", consecutiveErrors: 0 })
    expect(raised).toHaveLength(2)
  })

  it("advances the mark past the malformed object and persists it", async () => {
    const next = await runTick(dependenciesFor([]), { mark: "", consecutiveErrors: 0 })
    expect(next.mark).toBe(laterKey)
    const loaded = await loadState(stateFile())
    expect(loaded._tag === "LoadedState" ? loaded.state.mark : "").toBe(laterKey)
  })

  it("does not re-notify for events at or before the mark", async () => {
    const raised: DesktopNotification[] = []
    await runTick(dependenciesFor(raised), { mark: badKey, consecutiveErrors: 0 })
    expect(raised.map(notification => notification.title)).toStrictEqual(["Notification p8 · claude-code"])
  })

  it("delivers everything across a paginated listing", async () => {
    const raised: DesktopNotification[] = []
    await runTick(dependenciesFor(raised, bucketObjects, 1), { mark: "", consecutiveErrors: 0 })
    expect(raised).toHaveLength(2)
  })

  it("holds the mark and counts the error when the bucket is unreachable", async () => {
    const capturing = capturingLogger()
    captured = capturing.captured
    const dependencies: DaemonDependencies = {
      s3: createFakeS3({ objects: {}, failWith: new Error("NoSuchBucket") }).client,
      bucket: "missing",
      notifier: recordingNotifier([]),
      logger: capturing.logger,
      stateFile: stateFile()
    }
    const next = await runTick(dependencies, { mark: goodKey, consecutiveErrors: 1 })
    expect(next).toStrictEqual({ mark: goodKey, consecutiveErrors: 2 })
    expect((await loadState(stateFile()))._tag).toBe("NoState")

    const [failure] = entriesFor(captured, "Poll failed; backing off before the next attempt")
    expect(failure?.level).toBe("error")
    expect(failure?.bucket).toBe("missing")
    expect(failure?.reason).toBe("NoSuchBucket")
  })

  it("does nothing and keeps the mark when the bucket has no new objects", async () => {
    const raised: DesktopNotification[] = []
    const next = await runTick(dependenciesFor(raised, {}), { mark: goodKey, consecutiveErrors: 0 })
    expect(raised).toStrictEqual([])
    expect(next.mark).toBe(goodKey)
  })
})

/**
 * The log line is the whole user-visible signal for anything the daemon does not turn into a
 * notification, so `.agents/tests.md` requires it to be asserted, not just its effect.
 */
describe("runTick logging", () => {
  it("logs each skipped object at warn with its key and a reason naming the offending field", async () => {
    await runTick(dependenciesFor([]), { mark: "", consecutiveErrors: 0 })
    const skipped = entriesFor(captured, "Skipping unparseable event object")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.level).toBe("warn")
    expect(skipped[0]?.key).toBe(badKey)
    expect(String(skipped[0]?.reason)).toContain("priority")
  })

  it("logs a delivery per notified event, identifying the object and its triage fields", async () => {
    await runTick(dependenciesFor([]), { mark: "", consecutiveErrors: 0 })
    const delivered = entriesFor(captured, "Raised desktop notification")
    expect(delivered.map(entry => entry.key)).toStrictEqual([goodKey, laterKey])
    expect(delivered.every(entry => entry.level === "info")).toBe(true)
    expect(delivered[0]).toMatchObject({ source: "github", name: "new-pull-request", priority: 5, eventType: "alert" })
  })

  it("stamps every record with the service and environment the logging guidance requires", async () => {
    await runTick(dependenciesFor([]), { mark: "", consecutiveErrors: 0 })
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.every(entry => entry.service === "desktop-notifier" && entry.env === "dev")).toBe(true)
  })

  it("logs an undelivered notification at error, naming the adapter and the reason", async () => {
    const dependencies = dependenciesFor([], bucketObjects, 1000, failingNotifier("no notifier available"))
    await runTick(dependencies, { mark: "", consecutiveErrors: 0 })
    const failed = entriesFor(captured, "Could not raise desktop notification")
    expect(failed).toHaveLength(2)
    expect(failed[0]?.level).toBe("error")
    expect(failed[0]?.notifier).toBe("failing")
    expect(failed[0]?.reason).toBe("no notifier available")
  })

  it("says nothing when a poll finds nothing, so an idle daemon is quiet", async () => {
    await runTick(dependenciesFor([], {}), { mark: goodKey, consecutiveErrors: 0 })
    expect(captured).toStrictEqual([])
  })
})

describe("runDaemon", () => {
  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const raised: DesktopNotification[] = []
    const final = await runDaemon(
      dependenciesFor(raised),
      { pollIntervalMs: 1, maxBackoffMs: 2 },
      { mark: "", consecutiveErrors: 0 },
      controller.signal
    )
    expect(raised).toStrictEqual([])
    expect(final.mark).toBe("")
  })

  it("stops after finishing the tick it is in when aborted mid-run", async () => {
    const controller = new AbortController()
    const raised: DesktopNotification[] = []
    const running = runDaemon(
      dependenciesFor(raised),
      { pollIntervalMs: 50, maxBackoffMs: 50 },
      { mark: "", consecutiveErrors: 0 },
      controller.signal
    )
    controller.abort()
    const final = await running
    expect(final.mark).toBe(laterKey)
    expect(raised).toHaveLength(2)
  })

  it("runs many ticks and returns the state of the last one", async () => {
    const controller = new AbortController()
    const raised: DesktopNotification[] = []
    const running = runDaemon(
      dependenciesFor(raised, {}),
      { pollIntervalMs: 1, maxBackoffMs: 1 },
      { mark: goodKey, consecutiveErrors: 0 },
      controller.signal
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    controller.abort()
    expect((await running).mark).toBe(goodKey)
  })

  /**
   * Guards the scheduling shape rather than the output: a daemon that chains each tick's promise to
   * the next retains one pending promise and one async frame per tick for the life of the process.
   * Ticks must settle independently, so an early tick's promise must be resolved long before the
   * loop stops.
   */
  it("settles each tick independently instead of chaining them into one unbounded promise", async () => {
    const controller = new AbortController()
    const fake = createFakeS3({ objects: {} })
    const capturing = capturingLogger()
    captured = capturing.captured
    const running = runDaemon(
      {
        s3: fake.client,
        bucket: "events.test.personal-events.example.com",
        notifier: recordingNotifier([]),
        logger: capturing.logger,
        stateFile: stateFile()
      },
      { pollIntervalMs: 1, maxBackoffMs: 1 },
      { mark: goodKey, consecutiveErrors: 0 },
      controller.signal
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    // Many ticks completed while the outer promise was still pending, so no tick was waiting on a
    // later one to settle — each one's promise resolved and its frame unwound.
    const polls = fake.requests.filter(request => request.startsWith("list:")).length
    expect(polls).toBeGreaterThan(3)
    controller.abort()
    await running
  })
})

describe("nextDelayMs", () => {
  const schedule = { pollIntervalMs: 1000, maxBackoffMs: 10_000 }

  it("uses the plain interval when the last tick succeeded", () => {
    expect(nextDelayMs(schedule, 0, () => 0.5)).toBe(1000)
  })

  it("backs off exponentially while ticks keep failing", () => {
    expect(nextDelayMs(schedule, 1, () => 0.5)).toBe(2000)
    expect(nextDelayMs(schedule, 3, () => 0.5)).toBe(8000)
  })

  it("never exceeds the configured ceiling, jitter included", () => {
    expect(nextDelayMs(schedule, 20, () => 1)).toBeLessThanOrEqual(12_500)
    expect(nextDelayMs(schedule, 20, () => 0)).toBe(7500)
  })

  it("spreads restarted clients apart with +/-25% jitter", () => {
    expect(nextDelayMs(schedule, 1, () => 0)).toBe(1500)
    expect(nextDelayMs(schedule, 1, () => 1)).toBe(2500)
  })
})
