import { Either, ParseResult, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { MappingConfigSchema, OutputSchema } from "./mapping-config.ts"
import { readConfigExemplar } from "./testing/exemplars.ts"

const decodeConfig = Schema.decodeUnknownEither(MappingConfigSchema, { errors: "all" })
const decodeOutput = Schema.decodeUnknownEither(OutputSchema, { errors: "all" })

const failureMessageFor = (fileName: string): string =>
  Either.match(decodeConfig(readConfigExemplar(fileName)), {
    onLeft: error => ParseResult.TreeFormatter.formatErrorSync(error),
    onRight: () => "UNEXPECTEDLY VALID"
  })

describe("MappingConfigSchema over the exemplars", () => {
  it.for([["valid-config-minimal.json"], ["valid-config-with-secondary-processing.json"], ["valid-config-empty-rules.json"]])(
    "accepts %s",
    ([fileName]) => {
      expect(Either.isRight(decodeConfig(readConfigExemplar(fileName as string)))).toBe(true)
    }
  )

  it.for([
    ["invalid-config-missing-default.json", "default"],
    ["invalid-config-priority-out-of-range.json", "Priority"],
    ["invalid-config-unknown-event-type.json", "EventType"],
    ["invalid-config-dotted-name.json", "NoDotString"],
    ["invalid-config-non-string-trigger-field.json", "string"]
  ])("rejects %s, naming %s in the failure", ([fileName, expectedInMessage]) => {
    expect(failureMessageFor(fileName as string)).toContain(expectedInMessage as string)
  })
})

describe("OutputSchema", () => {
  it("reuses the event-model priority bound rather than restating it", () => {
    expect(Either.isRight(decodeOutput({ eventType: "alert", priority: 1 }))).toBe(true)
    expect(Either.isRight(decodeOutput({ eventType: "alert", priority: 8 }))).toBe(true)
    expect(Either.isLeft(decodeOutput({ eventType: "alert", priority: 0 }))).toBe(true)
    expect(Either.isLeft(decodeOutput({ eventType: "alert", priority: 9 }))).toBe(true)
  })

  it("rejects a fractional priority, because it becomes the single `p{n}` object-key digit", () => {
    expect(Either.isLeft(decodeOutput({ eventType: "alert", priority: 4.5 }))).toBe(true)
  })

  it("treats name and secondaryProcessing as genuinely optional", () => {
    expect(decodeOutput({ eventType: "notification", priority: 3 })).toStrictEqual(Either.right({ eventType: "notification", priority: 3 }))
  })
})
