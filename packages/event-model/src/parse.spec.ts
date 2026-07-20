import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { eventModelErrorReasons } from "./errors.ts"
import { encodeEvent, encodeEventJson, parseEvent, parseEventJson } from "./parse.ts"
import { readExemplar, readExemplarText } from "./testing/exemplars.ts"

const rejectedExemplars = [
  { file: "invalid-priority-out-of-range.json", mentions: "priority" },
  { file: "invalid-unknown-event-type.json", mentions: "eventType" },
  { file: "invalid-non-iso-timestamp.json", mentions: "timestamp" },
  { file: "invalid-dotted-source.json", mentions: "source" },
  { file: "invalid-missing-schema-version.json", mentions: "schemaVersion" },
  { file: "invalid-work-item-not-a-url.json", mentions: "workItem" }
]

describe("parseEvent", () => {
  it("accepts a real GitHub pull-request exemplar and exposes its typed fields", () => {
    const result = parseEvent(readExemplar("valid-github-pull-request.json"))
    expect(Either.isRight(result)).toBe(true)
    const event = Either.getOrThrow(result)
    expect(event.eventType).toBe("alert")
    expect(event.priority).toBe(5)
    expect(event.source).toBe("github")
    expect(event.name).toBe("new-pull-request")
    expect(event.workItem?.href).toBe("https://www.jira.com/browse/AWE-150")
    expect(event.payload.action).toBe("opened")
  })

  it("accepts an exemplar with no workItem and a millisecond-less timestamp", () => {
    const event = Either.getOrThrow(parseEvent(readExemplar("valid-agent-notification.json")))
    expect(event.workItem).toBeUndefined()
    expect(event.timestamp).toBe("2026-07-19T09:15:02Z")
    expect(event.acknowledged).toBe(true)
  })

  it.each(rejectedExemplars)("rejects $file naming $mentions in the failure message", ({ file, mentions }) => {
    const result = parseEvent(readExemplar(file))
    expect(Either.isLeft(result)).toBe(true)
    const error = Either.getOrThrow(Either.flip(result))
    expect(error.reason).toBe(eventModelErrorReasons.invalidEvent)
    expect(error.message).toContain(mentions)
  })

  it("rejects a non-object body rather than throwing", () => {
    const error = Either.getOrThrow(Either.flip(parseEvent("not an event")))
    expect(error.reason).toBe(eventModelErrorReasons.invalidEvent)
  })

  it("reports every field problem at once rather than stopping at the first", () => {
    const error = Either.getOrThrow(Either.flip(parseEvent({ schemaVersion: 1, priority: 99, source: "a.b" })))
    expect(error.message).toContain("priority")
    expect(error.message).toContain("source")
  })
})

describe("parseEventJson", () => {
  it("parses a well-formed exemplar body", () => {
    const event = Either.getOrThrow(parseEventJson(readExemplarText("valid-github-pull-request.json")))
    expect(event.source).toBe("github")
  })

  it("reports unparseable JSON separately from an invalid event", () => {
    const error = Either.getOrThrow(Either.flip(parseEventJson("{ not json")))
    expect(error.reason).toBe(eventModelErrorReasons.invalidEventJson)
    expect(error.message).toContain("not valid JSON")
  })

  it("reports valid JSON that is not a valid event as an invalid event", () => {
    const error = Either.getOrThrow(Either.flip(parseEventJson('{"schemaVersion":1}')))
    expect(error.reason).toBe(eventModelErrorReasons.invalidEvent)
  })
})

describe("encodeEvent", () => {
  it.each(["valid-github-pull-request.json", "valid-agent-notification.json"])(
    "round-trips %s byte-for-byte through decode → encode",
    file => {
      const raw = readExemplar(file)
      const encoded = Either.getOrThrow(Either.flatMap(parseEvent(raw), encodeEvent))
      expect(encoded).toStrictEqual(raw)
    }
  )

  it("serializes the workItem URL back to its string form", () => {
    const json = Either.getOrThrow(Either.flatMap(parseEvent(readExemplar("valid-github-pull-request.json")), encodeEventJson))
    expect(JSON.parse(json).workItem).toBe("https://www.jira.com/browse/AWE-150")
  })
})
