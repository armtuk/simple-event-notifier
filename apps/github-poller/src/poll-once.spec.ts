import { readGithubExemplar } from "@personal-events/github/testing"
import { describe, expect, it } from "vitest"
import { pollOnce } from "./poll-once.ts"
import type { PollResult, SourceCursor } from "./poll-result.ts"
import type { PollerState } from "./poller-state.ts"
import type { SourceDefinition } from "./source-cycle.ts"
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
  stateKey,
  stateRepositoryOver
} from "./testing/poller-fixtures.ts"

const signal = new AbortController().signal
const NOW = Date.parse("2026-07-20T00:00:00.000Z")

const scriptedRepo = (name: "notifications" | "events", result: PollResult) => ({
  name,
  poll: async (_cursor: SourceCursor): Promise<PollResult> => result
})

const itemsResult = (items: readonly unknown[], extra: Partial<PollResult> = {}): PollResult =>
  ({ status: "items", items, cursor: { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT" }, ...extra }) as PollResult

const notif = (result: PollResult): SourceDefinition => notificationsSource(scriptedRepo("notifications", result), compiledGithubConfig)
const events = (result: PollResult): SourceDefinition => eventsSource(scriptedRepo("events", result), compiledGithubConfig)

const orchestrate = async (sources: readonly SourceDefinition[], s3Options: FakeS3Options = {}) => {
  const log = capturingLogger()
  const s3 = fakeS3(s3Options)
  const summary = await pollOnce({
    state: stateRepositoryOver(s3, log.logger),
    sources,
    events: eventRepositoryOver(s3),
    seenCap: 100,
    logger: log.logger,
    signal,
    now: (): number => NOW
  })
  return { summary, s3, log }
}

const storedState = (s3: ReturnType<typeof fakeS3>): PollerState => JSON.parse(s3.stored.get(stateKey) ?? "{}")

const oneMention = [readGithubExemplar("notification-mention.json")]
const onePush = [readGithubExemplar("events-api-push.json")]

describe("pollOnce", () => {
  it("reads state once and writes it once, no matter how many sources ran", async () => {
    const { s3 } = await orchestrate([notif(itemsResult(oneMention)), events(itemsResult(onePush))])
    expect(commandsNamed(s3.commands, "GetObjectCommand")).toHaveLength(1)
    const statePuts = commandsNamed(s3.commands, "PutObjectCommand").filter(command => command.input.Key === stateKey)
    expect(statePuts).toHaveLength(1)
  })

  it("polls both sources in one invocation and sums what they wrote", async () => {
    const { summary, s3 } = await orchestrate([notif(itemsResult(oneMention)), events(itemsResult(onePush))])
    expect(summary.written).toBe(2)
    expect(summary.polled).toStrictEqual(["notifications", "events"])
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("writes each source's advance into its own branch of the single state object", async () => {
    const { s3 } = await orchestrate([notif(itemsResult(oneMention)), events(itemsResult(onePush))])
    expect(storedState(s3).notifications.seen).toHaveLength(1)
    expect(storedState(s3).events.seen).toHaveLength(1)
  })

  it("leaves the sibling branch untouched when only one source runs", async () => {
    const initial: PollerState = {
      notifications: { cursor: { since: "2026-07-01T00:00:00Z" }, seen: ["keep-me"] },
      events: { cursor: {}, seen: [] }
    }
    const { s3 } = await orchestrate([events(itemsResult(onePush))], { initialState: initial })
    expect(storedState(s3).notifications).toStrictEqual(initial.notifications)
    expect(storedState(s3).events.seen).toStrictEqual(["56138221773"])
  })

  it("skips a source whose notBefore has not elapsed, and still persists the object", async () => {
    const future = new Date(NOW + 60_000).toISOString()
    const initial: PollerState = { notifications: { cursor: {}, seen: [], notBefore: future }, events: { cursor: {}, seen: [] } }
    const { summary, s3, log } = await orchestrate([notif(itemsResult(oneMention)), events(itemsResult(onePush))], {
      initialState: initial
    })
    expect(summary.polled).toStrictEqual(["events"])
    expect(summary.skipped).toStrictEqual(["notifications"])
    expect(eventPuts(s3)).toHaveLength(1)
    expect(entriesFor(log.captured, "source not due yet; skipping this tick")[0]).toMatchObject({ source: "notifications" })
  })

  it("keeps the two sources' dedupe independent, so an overlapping activity is written by both channels", async () => {
    const { s3 } = await orchestrate([
      notif(itemsResult([readGithubExemplar("notification-review_requested.json")])),
      events(itemsResult([readGithubExemplar("events-api-pull_request-opened.json")]))
    ])
    expect(eventPuts(s3)).toHaveLength(2)
  })

  it("does not advance a source's cursor when its write fails, so it retries next invocation", async () => {
    const { s3 } = await orchestrate([notif(itemsResult(oneMention))], { failEventWrite: new Error("denied") })
    expect(storedState(s3).notifications.seen).toStrictEqual([])
  })

  it("reports an empty run when given no runnable sources", async () => {
    const { summary, s3 } = await orchestrate([])
    expect(summary).toStrictEqual({ written: 0, polled: [], skipped: [] })
    // State is still read and written once, harmlessly.
    expect(commandsNamed(s3.commands, "GetObjectCommand")).toHaveLength(1)
  })
})
