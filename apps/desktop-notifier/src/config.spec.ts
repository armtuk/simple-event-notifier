import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { configDefaults, defaultStateFile, type Environment, parseConfig } from "./config.ts"

const baseEnv: Environment = { EVENT_BUCKET: "events.prod.personal-events.fifthdimensionengineering.com", HOME: "/home/tester" }

describe("parseConfig", () => {
  it("accepts a minimal environment and fills in the documented defaults", () => {
    const config = Either.getOrThrow(parseConfig(baseEnv))
    expect(config.bucket).toBe(baseEnv.EVENT_BUCKET)
    expect(config.region).toBe(configDefaults.region)
    expect(config.pollIntervalMs).toBe(configDefaults.pollIntervalMs)
    expect(config.notifier).toBe(configDefaults.notifier)
    expect(config.logFile).toBeUndefined()
  })

  it("refuses to start without a bucket, naming the field", () => {
    const error = Either.getOrThrow(Either.flip(parseConfig({ HOME: "/home/tester" })))
    expect(error).toContain("bucket")
  })

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
    const config = Either.getOrThrow(parseConfig({ ...baseEnv, AWS_REGION: "eu-west-2", AWS_DEFAULT_REGION: "ap-south-1" }))
    expect(config.region).toBe("eu-west-2")
  })

  it.each(["0", "-1", "not-a-number", "1.5"])("rejects a poll interval of %o", value => {
    expect(Either.isLeft(parseConfig({ ...baseEnv, POLL_INTERVAL_MS: value }))).toBe(true)
  })

  it("rejects an unknown notifier kind rather than silently going silent", () => {
    const error = Either.getOrThrow(Either.flip(parseConfig({ ...baseEnv, NOTIFIER: "carrier-pigeon" })))
    expect(error).toContain("notifier")
  })

  it.each(["auto", "toasted", "shell"])("accepts the %s notifier", value => {
    expect(Either.getOrThrow(parseConfig({ ...baseEnv, NOTIFIER: value })).notifier).toBe(value)
  })
})

describe("defaultStateFile", () => {
  it("honours XDG_STATE_HOME when it is set", () => {
    expect(defaultStateFile({ XDG_STATE_HOME: "/xdg/state" })).toBe("/xdg/state/personal-events/desktop-notifier.json")
  })

  it("falls back to ~/.local/state when it is not", () => {
    expect(defaultStateFile({ HOME: "/home/tester" })).toBe("/home/tester/.local/state/personal-events/desktop-notifier.json")
  })
})
