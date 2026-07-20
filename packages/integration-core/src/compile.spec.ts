import { describe, expect, it } from "vitest"
import { matchKey } from "./channel.ts"
import { compileMappingConfig } from "./compile.ts"
import type { MappingConfig } from "./mapping-config.ts"

const config = (rules: MappingConfig["rules"]): MappingConfig => ({
  integration: "example",
  rules,
  default: { eventType: "notification", priority: 3 }
})

describe("compileMappingConfig", () => {
  it("keys each rule's output by its trigger match-key", () => {
    const compiled = compileMappingConfig(
      config([
        { trigger: { channel: "webhook", event: "issues", action: "opened" }, output: { eventType: "alert", priority: 5 } },
        { trigger: { channel: "notification", reason: "mention" }, output: { eventType: "notification", priority: 4 } }
      ])
    )
    expect(compiled.lookup.get(matchKey({ channel: "webhook", event: "issues", action: "opened" }))).toStrictEqual({
      eventType: "alert",
      priority: 5
    })
    expect(compiled.lookup.get(matchKey({ channel: "notification", reason: "mention" }))).toStrictEqual({
      eventType: "notification",
      priority: 4
    })
  })

  it("carries the config default through as the fallback", () => {
    expect(compileMappingConfig(config([])).fallback).toStrictEqual({ eventType: "notification", priority: 3 })
  })

  it("compiles an empty rule list to an empty lookup, so everything classifies to the default", () => {
    const compiled = compileMappingConfig(config([]))
    expect(compiled.lookup.size).toBe(0)
    expect(compiled.ruleCount).toBe(0)
  })

  it("resolves duplicate trigger keys last-wins, and exposes the discrepancy through ruleCount", () => {
    const compiled = compileMappingConfig(
      config([
        { trigger: { channel: "webhook", event: "push" }, output: { eventType: "notification", priority: 6 } },
        { trigger: { channel: "webhook", event: "push" }, output: { eventType: "alert", priority: 2 } }
      ])
    )
    expect(compiled.lookup.get("webhook:event=push")).toStrictEqual({ eventType: "alert", priority: 2 })
    expect(compiled.ruleCount).toBe(2)
    expect(compiled.lookup.size).toBe(1)
  })

  it("collapses two rules whose trigger fields differ only in authored order", () => {
    const compiled = compileMappingConfig(
      config([
        { trigger: { channel: "webhook", event: "issues", action: "opened" }, output: { eventType: "alert", priority: 5 } },
        { trigger: { channel: "webhook", action: "opened", event: "issues" }, output: { eventType: "notification", priority: 7 } }
      ])
    )
    expect(compiled.lookup.size).toBe(1)
  })

  it("keeps the integration name for failure messages", () => {
    expect(compileMappingConfig(config([])).integration).toBe("example")
  })
})
