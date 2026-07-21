import { buildEventKey, parseKey } from "@personal-events/event-model"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { compileMappingConfig } from "./compile.ts"
import type { MappingConfig } from "./mapping-config.ts"
import type { NormalizedEvent } from "./normalized-event.ts"
import { transform } from "./transform.ts"

const mapping: MappingConfig = {
  integration: "example",
  rules: [
    { trigger: { channel: "webhook", event: "issues", action: "opened" }, output: { eventType: "alert", priority: 5, name: "new-issue" } },
    { trigger: { channel: "notification", reason: "mention" }, output: { eventType: "notification", priority: 4 } }
  ],
  default: { eventType: "notification", priority: 3 }
}

const toEvent = transform(compileMappingConfig(mapping))

const normalized = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  source: "example",
  name: "issues-opened",
  timestamp: "2026-07-19T18:44:30.123Z",
  producer: "example-producer",
  eventId: "item-7",
  trigger: { channel: "webhook", event: "issues", action: "opened" },
  payload: { number: 7 },
  ...overrides
})

describe("transform", () => {
  it("classifies from the mapping config, not from code", () => {
    expect(Either.getOrThrow(toEvent(normalized()))).toMatchObject({ eventType: "alert", priority: 5 })
  })

  it("prefers the rule's configured name over the normalizer's", () => {
    expect(Either.getOrThrow(toEvent(normalized())).name).toBe("new-issue")
  })

  it("falls back to the normalizer's name when the rule declares none", () => {
    const event = Either.getOrThrow(toEvent(normalized({ name: "mention", trigger: { channel: "notification", reason: "mention" } })))
    expect(event.name).toBe("mention")
    expect(event.priority).toBe(4)
  })

  it("classifies an unmapped trigger to the config default rather than dropping it", () => {
    const event = Either.getOrThrow(
      toEvent(normalized({ name: "deployment-status", trigger: { channel: "webhook", event: "deployment_status" } }))
    )
    expect(event).toMatchObject({ eventType: "notification", priority: 3, name: "deployment-status" })
  })

  it("carries the normalizer's producer and eventId through to the event", () => {
    expect(Either.getOrThrow(toEvent(normalized()))).toMatchObject({ producer: "example-producer", eventId: "item-7" })
  })

  it("gives two normalized events that agree on everything but eventId distinct object keys", () => {
    const a = Either.getOrThrow(toEvent(normalized({ eventId: "aaa" })))
    const b = Either.getOrThrow(toEvent(normalized({ eventId: "bbb" })))
    expect(buildEventKey(a)).not.toBe(buildEventKey(b))
  })

  it("carries the raw payload through untouched", () => {
    const payload = { number: 7, nested: { deeply: ["a", 1, null] } }
    expect(Either.getOrThrow(toEvent(normalized({ payload }))).payload).toStrictEqual(payload)
  })

  it("stamps the canonical constants a producer must not choose", () => {
    expect(Either.getOrThrow(toEvent(normalized()))).toMatchObject({
      schemaVersion: 1,
      acknowledged: false,
      handled: false,
      source: "example",
      timestamp: "2026-07-19T18:44:30.123Z"
    })
  })

  it("omits workItem entirely when the normalizer supplies none", () => {
    expect(Either.getOrThrow(toEvent(normalized()))).not.toHaveProperty("workItem")
  })

  it("carries a workItem link through verbatim when the normalizer supplies one", () => {
    const event = Either.getOrThrow(toEvent(normalized({ workItem: "https://github.com/o/r/issues/7" })))
    expect(event.workItem).toBe("https://github.com/o/r/issues/7")
  })

  it("produces an event whose object key round-trips through the codec", () => {
    const event = Either.getOrThrow(toEvent(normalized()))
    const key = buildEventKey(event)
    expect(key).toBe("2026-07-19T18:44:30.123Z.alert.p5.example.new-issue.example-producer.item-7.json")
    expect(Either.isRight(parseKey(key))).toBe(true)
  })

  it("fails typed rather than emitting a corrupt event when the normalizer's timestamp is not a canonical instant", () => {
    const failed = toEvent(normalized({ timestamp: "2026-07-19T18:44:30Z" }))
    expect(Either.isLeft(failed)).toBe(true)
    expect(Either.getOrElse(Either.flip(failed), () => undefined)?._tag).toBe("TransformError")
  })

  it("names the integration and the sought match-key in a transform failure", () => {
    const failure = Either.getOrThrow(Either.flip(toEvent(normalized({ timestamp: "nonsense" }))))
    expect(failure.integration).toBe("example")
    expect(failure.matchKey).toBe("webhook:action=opened&event=issues")
    expect(failure.reason).toContain("timestamp")
  })

  it("fails typed rather than writing an unparseable key when a workItem is not a URL", () => {
    expect(Either.isLeft(toEvent(normalized({ workItem: "not a url" })))).toBe(true)
  })

  it("refuses a dotted source, because NoDotString is a nominal-free string type the compiler cannot enforce", () => {
    const failure = Either.getOrThrow(Either.flip(toEvent(normalized({ source: "github.com" }))))
    expect(failure.reason).toContain("source")
  })
})
