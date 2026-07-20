import { readGithubExemplar } from "@personal-events/github/testing"
import { describe, expect, it } from "vitest"
import type { PollResult, SourceCursor } from "./poll-result.ts"
import { emptyPollerState, type PollerState } from "./poller-state.ts"
import { runSourceCycle } from "./source-cycle.ts"
import type { GithubSourceRepository } from "./source-repositories.ts"
import { eventsSource, notificationsSource } from "./sources.ts"
import {
  capturingLogger,
  commandsNamed,
  compiledGithubConfig,
  entriesFor,
  eventPuts,
  eventRepositoryOver,
  type FakeS3Options,
  fakeS3,
  stateBucket,
  stateKey,
  stateRepositoryOver
} from "./testing/poller-fixtures.ts"

const signal = new AbortController().signal

const scriptedRepository = (results: readonly PollResult[]): GithubSourceRepository & { cursors: SourceCursor[] } => {
  const cursors: SourceCursor[] = []
  return {
    name: "notifications",
    cursors,
    poll: async (cursor: SourceCursor): Promise<PollResult> => {
      cursors.push(cursor)
      return results[Math.min(cursors.length - 1, results.length - 1)] ?? { status: "failure", message: "no script" }
    }
  }
}

const notificationItems = [readGithubExemplar("notification-review_requested.json"), readGithubExemplar("notification-mention.json")]

const cycleFor = (results: readonly PollResult[], s3Options: FakeS3Options = {}, source = notificationsSource) => {
  const log = capturingLogger()
  const s3 = fakeS3(s3Options)
  const repository = scriptedRepository(results)
  const cycle = runSourceCycle({
    source: source(repository, compiledGithubConfig),
    state: stateRepositoryOver(s3, log.logger),
    events: eventRepositoryOver(s3),
    seenCap: 100,
    logger: log.logger,
    signal
  })
  return { cycle, s3, log, repository }
}

const storedState = (s3: ReturnType<typeof fakeS3>): PollerState => JSON.parse(s3.stored.get(stateKey) ?? JSON.stringify(emptyPollerState))

const itemsResult = (items: readonly unknown[], extra: Partial<PollResult> = {}): PollResult =>
  ({ status: "items", items, cursor: { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT" }, ...extra }) as PollResult

describe("runSourceCycle — the happy path", () => {
  it("writes one canonical event per fresh item", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)])
    const outcome = await cycle()
    expect(outcome).toMatchObject({ failed: false, written: 2 })
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("writes events into the event bucket and state into the state bucket", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    const buckets = new Set(commandsNamed(s3.commands, "PutObjectCommand").map(command => String(command.input.Bucket)))
    expect([...buckets].toSorted()).toStrictEqual(["events.prod.personal-events.fifthdimensionengineering.com", stateBucket])
  })

  it("advances the cursor and the seen set after a successful write", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    expect(storedState(s3).notifications.cursor.lastModified).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
    expect(storedState(s3).notifications.seen).toHaveLength(2)
  })

  it("advances the since cursor to the newest updated_at in the page", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    expect(storedState(s3).notifications.cursor.since).toBe("2026-07-19T19:02:11Z")
  })

  it("passes the persisted cursor back on the next poll, so a restart resumes", async () => {
    const { cycle, repository } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    await cycle()
    expect(repository.cursors[1]?.lastModified).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })

  it("writes nothing the second time it sees the same page — dedupe across cycles", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    const after = eventPuts(s3).length
    const second = await cycle()
    expect(second.written).toBe(0)
    expect(eventPuts(s3)).toHaveLength(after)
  })

  it("logs what it fetched, what was fresh, and what it wrote", async () => {
    const { cycle, log } = cycleFor([itemsResult(notificationItems)])
    await cycle()
    expect(entriesFor(log.captured, "polled")[0]).toMatchObject({ source: "notifications", fetched: 2, fresh: 2, written: 2 })
  })
})

describe("runSourceCycle — nothing to do", () => {
  it("does no work and touches no state on a 304", async () => {
    const { cycle, s3 } = cycleFor([{ status: "not-modified", pollIntervalMs: 120_000 }])
    expect(await cycle()).toStrictEqual({ failed: false, written: 0, pollIntervalMs: 120_000 })
    expect(commandsNamed(s3.commands, "PutObjectCommand")).toHaveLength(0)
  })

  it("carries the server's poll interval out so the loop can honour it", async () => {
    const { cycle } = cycleFor([itemsResult([], { pollIntervalMs: 300_000 } as Partial<PollResult>)])
    expect((await cycle()).pollIntervalMs).toBe(300_000)
  })

  it("saves state even for an empty page, so the cursor still advances", async () => {
    const { cycle, s3 } = cycleFor([itemsResult([])])
    await cycle()
    expect(storedState(s3).notifications.cursor.lastModified).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })
})

describe("runSourceCycle — failures", () => {
  it("reports a rate limit as failed and passes Retry-After to the loop", async () => {
    const { cycle, log } = cycleFor([{ status: "rate-limited", retryAfterMs: 60_000, message: "throttled" }])
    expect(await cycle()).toStrictEqual({ failed: true, written: 0, retryAfterMs: 60_000 })
    expect(entriesFor(log.captured, "rate limited by GitHub; backing off")[0]?.level).toBe("warn")
  })

  it("reports a poll failure without touching state", async () => {
    const { cycle, s3, log } = cycleFor([{ status: "failure", message: "HTTP 502" }])
    expect(await cycle()).toStrictEqual({ failed: true, written: 0 })
    expect(commandsNamed(s3.commands, "PutObjectCommand")).toHaveLength(0)
    expect(entriesFor(log.captured, "poll failed")[0]?.level).toBe("error")
  })

  it("does NOT advance the cursor when the write fails, so the items are retried", async () => {
    const { cycle, s3, log } = cycleFor([itemsResult(notificationItems)], { failEventWrite: new Error("access denied") })
    expect(await cycle()).toStrictEqual({ failed: true, written: 0 })
    expect(s3.stored.has(stateKey)).toBe(false)
    expect(entriesFor(log.captured, "could not write events; NOT advancing the cursor so they are retried")[0]?.level).toBe("error")
  })

  it("retries the same items on the next cycle after a write failure — nothing was deduped away", async () => {
    const { cycle, s3 } = cycleFor([itemsResult(notificationItems)], { failEventWrite: new Error("denied") })
    await cycle()
    await cycle()
    // Two items attempted twice: the seen-set never advanced, so the second cycle saw them as fresh.
    expect(eventPuts(s3)).toHaveLength(4)
    expect(s3.stored.has(stateKey)).toBe(false)
  })

  it("skips a malformed item, naming it, and still writes its healthy siblings", async () => {
    const mixed = [readGithubExemplar("notification-mention.json"), { id: "broken-1", reason: "mention" }]
    const { cycle, s3, log } = cycleFor([itemsResult(mixed)])
    expect((await cycle()).written).toBe(1)
    expect(eventPuts(s3)).toHaveLength(1)
    expect(entriesFor(log.captured, "skipping unprocessable item")[0]).toMatchObject({ source: "notifications", itemId: "broken-1" })
  })

  it("a page of nothing but malformed items is not a failure — it is a page with no events in it", async () => {
    const { cycle, s3 } = cycleFor([itemsResult([{ nonsense: true }])])
    expect(await cycle()).toMatchObject({ failed: false, written: 0 })
    expect(s3.stored.has(stateKey)).toBe(true)
  })
})

describe("runSourceCycle — the events source uses the same machinery", () => {
  it("classifies and writes activity items", async () => {
    const items = [readGithubExemplar("events-api-pull_request-opened.json"), readGithubExemplar("events-api-push.json")]
    const { cycle, s3 } = cycleFor([itemsResult(items)], {}, eventsSource)
    expect((await cycle()).written).toBe(2)
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("writes into its own branch of the state object, leaving the sibling source untouched", async () => {
    const items = [readGithubExemplar("events-api-push.json")]
    const initial: PollerState = {
      notifications: { cursor: { since: "2026-07-01T00:00:00Z" }, seen: ["keep-me"] },
      events: { cursor: {}, seen: [] }
    }
    const { cycle, s3 } = cycleFor([itemsResult(items)], { initialState: initial }, eventsSource)
    await cycle()
    expect(storedState(s3).notifications).toStrictEqual(initial.notifications)
    expect(storedState(s3).events.seen).toStrictEqual(["56138221773"])
  })

  it("does not set a since cursor, because the Events API has no such parameter", async () => {
    const { cycle, s3 } = cycleFor([itemsResult([readGithubExemplar("events-api-push.json")])], {}, eventsSource)
    await cycle()
    expect(storedState(s3).events.cursor.since).toBeUndefined()
  })

  it("keeps the two sources' dedupe sets independent, so an overlapping item is written by both", async () => {
    const s3Options = { initialState: { notifications: { cursor: {}, seen: [] }, events: { cursor: {}, seen: [] } } as PollerState }
    const notifications = cycleFor([itemsResult([readGithubExemplar("notification-review_requested.json")])], s3Options)
    await notifications.cycle()
    expect(eventPuts(notifications.s3)).toHaveLength(1)

    const events = cycleFor([itemsResult([readGithubExemplar("events-api-pull_request-opened.json")])], s3Options, eventsSource)
    await events.cycle()
    expect(eventPuts(events.s3)).toHaveLength(1)
  })
})
