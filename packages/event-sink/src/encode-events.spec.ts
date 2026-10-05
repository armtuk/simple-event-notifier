import { buildEventKey, type Event, parseEvent, parseKey } from "@personal-events/event-model"
import { readExemplarEvent } from "@personal-events/event-model/testing"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { toEventObjects } from "./encode-events.ts"

const pullRequest = readExemplarEvent("valid-github-pull-request.json")
const agentNotification = readExemplarEvent("valid-agent-notification.json")

describe("toEventObjects", () => {
  it("pairs each event with the key the contract's codec builds for it", () => {
    const objects = Either.getOrThrow(toEventObjects([pullRequest, agentNotification]))
    expect(objects.map(object => object.key)).toStrictEqual([buildEventKey(pullRequest), buildEventKey(agentNotification)])
  })

  it("produces a body that parses back to the same event, so key and body agree", () => {
    const [object] = Either.getOrThrow(toEventObjects([pullRequest]))
    expect(Either.getOrThrow(parseEvent(JSON.parse(object?.body ?? "")))).toStrictEqual(pullRequest)
  })

  it("produces keys the codec can parse back", () => {
    const objects = Either.getOrThrow(toEventObjects([pullRequest, agentNotification]))
    expect(objects.filter(object => Either.isLeft(parseKey(object.key)))).toStrictEqual([])
  })

  it("encodes a workItem byte-identically rather than through URL normalization", () => {
    const withUnnormalizedLink: Event = { ...pullRequest, workItem: "https://github.com" }
    const [object] = Either.getOrThrow(toEventObjects([withUnnormalizedLink]))
    expect(JSON.parse(object?.body ?? "").workItem).toBe("https://github.com")
  })

  it("returns an empty list for an empty batch rather than failing", () => {
    expect(Either.getOrThrow(toEventObjects([]))).toStrictEqual([])
  })

  it("fails the whole batch when one event is unencodable, rather than writing a partial one", () => {
    const corrupt = { ...pullRequest, timestamp: "not an instant" } as Event
    const failed = toEventObjects([pullRequest, corrupt])
    expect(Either.isLeft(failed)).toBe(true)
    expect(Either.getOrThrow(Either.flip(failed)).reason).toBe("invalidEvent")
  })

  it("preserves batch order, so a caller can correlate results with what it passed in", () => {
    const objects = Either.getOrThrow(toEventObjects([agentNotification, pullRequest]))
    expect(objects[0]?.key).toBe(buildEventKey(agentNotification))
  })
})
