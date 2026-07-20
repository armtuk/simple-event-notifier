import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { eventModelErrorReasons } from "./errors.ts"
import { buildEventKey, buildKey, type EventKeyComponents, parseKey, toKeyComponents } from "./event-key.ts"
import { parseEvent } from "./parse.ts"
import { readExemplar } from "./testing/exemplars.ts"

const githubComponents: EventKeyComponents = {
  timestamp: "2026-06-28T18:44:30.123Z",
  eventType: "alert",
  priority: 5,
  source: "github",
  name: "new-pull-request"
}

const githubKey = "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json"

const malformedKeys = [
  { key: "2026-06-28T18:44:30.123Z.alert.p5.github.json", why: "a missing name segment" },
  { key: "2026-06-28T18:44:30.123Z.alert.p5.github.new.pull.request.json", why: "a dotted name segment" },
  { key: "2026-06-28T18:44:30.123Z.alert.5.github.new-pull-request.json", why: "a priority without its p prefix" },
  { key: "2026-06-28T18:44:30.123Z.warning.p5.github.new-pull-request.json", why: "an unknown event type" },
  { key: "28-06-2026.alert.p5.github.new-pull-request.json", why: "a non-ISO timestamp" },
  { key: "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.txt", why: "the wrong suffix" },
  { key: "", why: "an empty key" }
]

describe("buildKey", () => {
  it("renders the README's canonical key layout", () => {
    expect(buildKey(githubComponents)).toBe(githubKey)
  })

  it.each([1, 8])("encodes priority %i with the p prefix", priority => {
    expect(buildKey({ ...githubComponents, priority })).toContain(`.p${priority}.`)
  })

  it("keeps the timestamp first so keys sort chronologically", () => {
    const earlier = buildKey({ ...githubComponents, timestamp: "2026-06-28T18:44:30.122Z" })
    expect([githubKey, earlier].sort()).toStrictEqual([earlier, githubKey])
  })
})

describe("parseKey", () => {
  it("recovers every component of a canonical key", () => {
    expect(Either.getOrThrow(parseKey(githubKey))).toStrictEqual(githubComponents)
  })

  it("recovers a millisecond-less timestamp", () => {
    const components = Either.getOrThrow(parseKey("2026-07-19T09:15:02Z.notification.p8.claude-code.prompt-complete.json"))
    expect(components.timestamp).toBe("2026-07-19T09:15:02Z")
    expect(components.priority).toBe(8)
  })

  it.each(malformedKeys)("rejects a key with $why", ({ key }) => {
    const result = parseKey(key)
    expect(Either.isLeft(result)).toBe(true)
    const error = Either.getOrThrow(Either.flip(result))
    expect(error.reason).toBe(eventModelErrorReasons.invalidEventKey)
    expect(error.message).toContain(key)
  })

  it("rejects an out-of-range priority even though the key is structurally well formed", () => {
    const error = Either.getOrThrow(Either.flip(parseKey("2026-06-28T18:44:30.123Z.alert.p9.github.new-pull-request.json")))
    expect(error.message).toContain("priority")
  })
})

describe("round trip", () => {
  it.each(["valid-github-pull-request.json", "valid-agent-notification.json"])("takes %s from event → key → components", file => {
    const event = Either.getOrThrow(parseEvent(readExemplar(file)))
    const components = Either.getOrThrow(parseKey(buildEventKey(event)))
    expect(components).toStrictEqual(toKeyComponents(event))
  })

  it("takes a key → components → key unchanged", () => {
    expect(buildKey(Either.getOrThrow(parseKey(githubKey)))).toBe(githubKey)
  })
})
