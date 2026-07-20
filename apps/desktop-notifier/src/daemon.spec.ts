import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Logger } from "winston"
import { type DaemonDependencies, nextDelayMs, runDaemon, runTick } from "./daemon.ts"
import { createDaemonLogger } from "./logger.ts"
import type { DesktopNotification } from "./notification-content.ts"
import type { NotifierAdapter, NotifyResult } from "./notify.ts"
import { loadState } from "./state.ts"
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

const silentLogger = (): Logger => createDaemonLogger({ level: "error", env: "dev" })

let directory = ""

const stateFile = (): string => join(directory, "state.json")

const dependenciesFor = (raised: DesktopNotification[], objects = bucketObjects, pageSize = 1000): DaemonDependencies => ({
  s3: createFakeS3({ objects, pageSize }).client,
  bucket: "events.test.personal-events.example.com",
  notifier: recordingNotifier(raised),
  logger: silentLogger(),
  stateFile: stateFile()
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-events-daemon-"))
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
    const dependencies: DaemonDependencies = {
      s3: createFakeS3({ objects: {}, failWith: new Error("NoSuchBucket") }).client,
      bucket: "missing",
      notifier: recordingNotifier([]),
      logger: silentLogger(),
      stateFile: stateFile()
    }
    const next = await runTick(dependencies, { mark: goodKey, consecutiveErrors: 1 })
    expect(next).toStrictEqual({ mark: goodKey, consecutiveErrors: 2 })
    expect((await loadState(stateFile()))._tag).toBe("NoState")
  })

  it("does nothing and keeps the mark when the bucket has no new objects", async () => {
    const raised: DesktopNotification[] = []
    const next = await runTick(dependenciesFor(raised, {}), { mark: goodKey, consecutiveErrors: 0 })
    expect(raised).toStrictEqual([])
    expect(next.mark).toBe(goodKey)
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
