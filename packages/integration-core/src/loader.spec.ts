import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { loadMappingConfig } from "./loader.ts"
import { readConfigExemplar } from "./testing/exemplars.ts"

const load = (fileName: string, knownProcessors: readonly string[] = []) =>
  loadMappingConfig(readConfigExemplar(fileName), { knownProcessors })

describe("loadMappingConfig", () => {
  it("compiles a valid config", () => {
    const loaded = Either.getOrThrow(load("valid-config-minimal.json"))
    expect(loaded.integration).toBe("example")
    expect(loaded.lookup.get("webhook:event=thing_happened")).toStrictEqual({
      eventType: "notification",
      priority: 4,
      name: "thing-happened"
    })
  })

  it("accepts a config whose declared processors are all registered", () => {
    expect(Either.isRight(load("valid-config-with-secondary-processing.json", ["open-ticket", "page-oncall"]))).toBe(true)
  })

  it("reports an unknown processor rather than silently ignoring it", () => {
    const failure = Either.getOrThrow(Either.flip(load("valid-config-with-secondary-processing.json", ["open-ticket"])))
    expect(failure._tag).toBe("UnknownProcessorError")
    expect(failure).toMatchObject({ integration: "example", unknownNames: ["page-oncall"], knownNames: ["open-ticket"] })
  })

  it("checks the default's processors too, not just the rules'", () => {
    const failure = Either.getOrThrow(Either.flip(load("valid-config-with-secondary-processing.json", ["page-oncall"])))
    expect(failure).toMatchObject({ _tag: "UnknownProcessorError", unknownNames: ["open-ticket"] })
  })

  it("reports every unknown name at once, so a config is fixed in one pass", () => {
    const failure = Either.getOrThrow(Either.flip(load("valid-config-with-secondary-processing.json")))
    expect(failure).toMatchObject({ unknownNames: ["open-ticket", "page-oncall"] })
  })

  it("treats an empty secondaryProcessing list as declaring nothing", () => {
    expect(Either.isRight(load("valid-config-minimal.json"))).toBe(true)
  })

  it.for([
    ["invalid-config-missing-default.json"],
    ["invalid-config-priority-out-of-range.json"],
    ["invalid-config-unknown-event-type.json"],
    ["invalid-config-dotted-name.json"],
    ["invalid-config-non-string-trigger-field.json"]
  ])("fails %s with a typed ConfigParseError naming the integration", ([fileName]) => {
    const failure = Either.getOrThrow(Either.flip(load(fileName as string)))
    expect(failure._tag).toBe("ConfigParseError")
    expect(failure).toMatchObject({ integration: "example" })
  })

  it("names the integration as unknown when the config is not even an object", () => {
    const failure = Either.getOrThrow(Either.flip(loadMappingConfig("not a config", { knownProcessors: [] })))
    expect(failure).toMatchObject({ _tag: "ConfigParseError", integration: "unknown" })
  })

  it("compiles a config with no rules, so every event classifies to the default", () => {
    const loaded = Either.getOrThrow(load("valid-config-empty-rules.json"))
    expect(loaded.lookup.size).toBe(0)
    expect(loaded.fallback).toStrictEqual({ eventType: "alert", priority: 8 })
  })
})
