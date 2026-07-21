import { readGithubExemplar } from "@personal-events/github/testing"
import { describe, expect, it } from "vitest"
import type { PollResult, SourceCursor } from "./poll-result.ts"
import { emptySourceState, type SourceState } from "./poller-state.ts"
import { type CycleResult, runSourceCycle } from "./source-cycle.ts"
import type { GithubSourceRepository } from "./source-repositories.ts"
import { eventsSource, notificationsSource } from "./sources.ts"
import {
  capturingLogger,
  compiledGithubConfig,
  entriesFor,
  eventPuts,
  eventRepositoryOver,
  fakeS3,
  storedEventKeys
} from "./testing/poller-fixtures.ts"

const signal = new AbortController().signal
const NOW = Date.parse("2026-07-20T00:00:00.000Z")

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

/** The cycle is pure over `SourceState` — no state repo. The invocation owns load/save (poll-once). */
const cycleFor = (results: readonly PollResult[], source = notificationsSource) => {
  const log = capturingLogger()
  const s3 = fakeS3()
  const repository = scriptedRepository(results)
  const cycle = runSourceCycle({
    source: source(repository, compiledGithubConfig),
    events: eventRepositoryOver(s3),
    seenCap: 100,
    logger: log.logger,
    signal,
    now: (): number => NOW
  })
  return { cycle, s3, log, repository }
}

const itemsResult = (items: readonly unknown[], extra: Partial<PollResult> = {}): PollResult =>
  ({ status: "items", items, cursor: { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT" }, ...extra }) as PollResult

const run = async (
  results: readonly PollResult[],
  state: SourceState = emptySourceState,
  source = notificationsSource
): Promise<CycleResult & { s3: ReturnType<typeof fakeS3>; log: ReturnType<typeof capturingLogger> }> => {
  const { cycle, s3, log } = cycleFor(results, source)
  const result = await cycle(state)
  return { ...result, s3, log }
}

describe("runSourceCycle — the happy path", () => {
  it("writes one canonical event per fresh item", async () => {
    const { outcome, s3 } = await run([itemsResult(notificationItems)])
    expect(outcome).toStrictEqual({ failed: false, written: 2 })
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("advances the cursor and the seen set in the returned state after a successful write", async () => {
    const { next } = await run([itemsResult(notificationItems)])
    expect(next.cursor.lastModified).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
    expect(next.seen).toHaveLength(2)
  })

  it("advances the since cursor to the newest updated_at in the page", async () => {
    const { next } = await run([itemsResult(notificationItems)])
    expect(next.cursor.since).toBe("2026-07-19T19:02:11Z")
  })

  it("polls with the cursor it is given, so a resumed state resumes conditionally", async () => {
    const { cycle, repository } = cycleFor([itemsResult(notificationItems)])
    await cycle({ cursor: { lastModified: "Sat, 18 Jul 2026 00:00:00 GMT" }, seen: [] })
    expect(repository.cursors[0]?.lastModified).toBe("Sat, 18 Jul 2026 00:00:00 GMT")
  })

  it("writes nothing the second time it sees the same page — dedupe across cycles by threading state", async () => {
    const first = await run([itemsResult(notificationItems)])
    const second = await run([itemsResult(notificationItems)], first.next)
    expect(second.outcome.written).toBe(0)
    expect(eventPuts(second.s3)).toHaveLength(0)
  })

  it("logs what it fetched, what was fresh, and what it wrote", async () => {
    const { log } = await run([itemsResult(notificationItems)])
    expect(entriesFor(log.captured, "polled")[0]).toMatchObject({ source: "notifications", fetched: 2, fresh: 2, written: 2 })
  })
})

describe("runSourceCycle — server intervals become notBefore", () => {
  it("records notBefore = now + X-Poll-Interval on a 304, so the source is skipped until then", async () => {
    const { next, outcome } = await run([{ status: "not-modified", pollIntervalMs: 120_000 }])
    expect(outcome).toStrictEqual({ failed: false, written: 0 })
    expect(next.notBefore).toBe(new Date(NOW + 120_000).toISOString())
  })

  it("records notBefore from a page's X-Poll-Interval too", async () => {
    const { next } = await run([itemsResult([], { pollIntervalMs: 300_000 } as Partial<PollResult>)])
    expect(next.notBefore).toBe(new Date(NOW + 300_000).toISOString())
  })

  it("clears a stale notBefore when a poll succeeds without one", async () => {
    const { next } = await run([itemsResult(notificationItems)], { cursor: {}, seen: [], notBefore: "2020-01-01T00:00:00.000Z" })
    expect(next).not.toHaveProperty("notBefore")
  })
})

describe("runSourceCycle — failures", () => {
  it("reports a rate limit as failed and defers the next poll via notBefore", async () => {
    const { next, outcome, log } = await run([{ status: "rate-limited", retryAfterMs: 60_000, message: "throttled" }])
    expect(outcome).toStrictEqual({ failed: true, written: 0 })
    expect(next.notBefore).toBe(new Date(NOW + 60_000).toISOString())
    expect(entriesFor(log.captured, "rate limited by GitHub; deferring the next poll")[0]?.level).toBe("warn")
  })

  it("returns the state unchanged on a poll failure, writing nothing", async () => {
    const state: SourceState = { cursor: { etag: 'W/"x"' }, seen: ["a"] }
    const { next, outcome, s3, log } = await run([{ status: "failure", message: "HTTP 502" }], state)
    expect(outcome).toStrictEqual({ failed: true, written: 0 })
    expect(next).toStrictEqual(state)
    expect(eventPuts(s3)).toHaveLength(0)
    expect(entriesFor(log.captured, "poll failed")[0]?.level).toBe("error")
  })

  it("does NOT advance the cursor when the write fails — it returns the prior state so items are retried", async () => {
    const prior: SourceState = { cursor: { lastModified: "old" }, seen: ["already"] }
    const { cycle, log } = (() => {
      const l = capturingLogger()
      const s3 = fakeS3({ failEventWrite: new Error("access denied") })
      return {
        cycle: runSourceCycle({
          source: notificationsSource(scriptedRepository([itemsResult(notificationItems)]), compiledGithubConfig),
          events: eventRepositoryOver(s3),
          seenCap: 100,
          logger: l.logger,
          signal,
          now: (): number => NOW
        }),
        log: l
      }
    })()
    const { next, outcome } = await cycle(prior)
    expect(outcome).toStrictEqual({ failed: true, written: 0 })
    expect(next).toStrictEqual(prior)
    expect(entriesFor(log.captured, "could not write events; NOT advancing the cursor so they are retried")[0]?.level).toBe("error")
  })

  it("skips a malformed item, naming it, and still writes its healthy siblings", async () => {
    const mixed = [readGithubExemplar("notification-mention.json"), { id: "broken-1", reason: "mention" }]
    const { outcome, s3, log } = await run([itemsResult(mixed)])
    expect(outcome.written).toBe(1)
    expect(eventPuts(s3)).toHaveLength(1)
    expect(entriesFor(log.captured, "skipping unprocessable item")[0]).toMatchObject({ source: "notifications", itemId: "broken-1" })
  })

  it("a page of nothing but malformed items is not a failure — it is a page with no events in it", async () => {
    const { outcome, next } = await run([itemsResult([{ nonsense: true }])])
    expect(outcome).toMatchObject({ failed: false, written: 0 })
    expect(next.cursor.lastModified).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })
})

describe("runSourceCycle — the events source uses the same machinery", () => {
  it("classifies and writes activity items", async () => {
    const items = [readGithubExemplar("events-api-pull_request-opened.json"), readGithubExemplar("events-api-push.json")]
    const { outcome, s3 } = await run([itemsResult(items)], emptySourceState, eventsSource)
    expect(outcome.written).toBe(2)
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("does not set a since cursor, because the Events API has no such parameter", async () => {
    const { next } = await run([itemsResult([readGithubExemplar("events-api-push.json")])], emptySourceState, eventsSource)
    expect(next.cursor.since).toBeUndefined()
  })
})

/**
 * ## Characterization: two events, one object key — the R1-2 collision
 *
 * The S3 object key carries **no per-item identity** (in this commit — the event-model contract
 * change that adds `producer`/`eventId` and fixes it lands next), so two distinct notifications with
 * the same `reason` in the same second produce a byte-identical key and the second overwrites the
 * first. These specs assert on **stored keys**, not on `PutObjectCommand` count, because counting
 * puts cannot see the collapse. They flip to asserting two surviving objects once the contract
 * change lands.
 */
describe("runSourceCycle — two same-second, same-reason items collapse onto one key (characterization)", () => {
  const sameSecondMention = (id: string, title: string): unknown => ({
    id,
    reason: "mention",
    updated_at: "2026-07-19T19:02:11Z",
    subject: { title, type: "Issue", url: `https://api.github.com/repos/o/r/issues/${id}` },
    repository: { full_name: "o/r" }
  })

  const twoMentions = [sameSecondMention("111", "first distinct mention"), sameSecondMention("222", "second distinct mention")]

  it("writes both events and reports success", async () => {
    const { outcome } = await run([itemsResult(twoMentions)])
    expect(outcome).toMatchObject({ failed: false, written: 2 })
  })

  it("leaves only ONE object in the bucket: the second overwrote the first", async () => {
    const { s3 } = await run([itemsResult(twoMentions)])
    expect(storedEventKeys(s3)).toStrictEqual(["2026-07-19T19:02:11.000Z.alert.p4.github.mention.json"])
  })
})
