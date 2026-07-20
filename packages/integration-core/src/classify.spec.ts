import { describe, expect, it } from "vitest"
import { classify } from "./classify.ts"
import { compileMappingConfig } from "./compile.ts"
import type { MappingConfig } from "./mapping-config.ts"

const mapping: MappingConfig = {
  integration: "example",
  rules: [
    { trigger: { channel: "webhook", event: "issues", action: "opened" }, output: { eventType: "alert", priority: 5, name: "new-issue" } },
    { trigger: { channel: "notification", reason: "mention" }, output: { eventType: "notification", priority: 4 } }
  ],
  default: { eventType: "notification", priority: 3 }
}

const compiled = compileMappingConfig(mapping)

describe("classify", () => {
  it("reports a matched rule's output and marks it matched", () => {
    expect(classify(compiled, { channel: "webhook", event: "issues", action: "opened" })).toStrictEqual({
      output: { eventType: "alert", priority: 5, name: "new-issue" },
      matchKey: "webhook:action=opened&event=issues",
      matched: true
    })
  })

  it("falls back to the config default for an unmapped trigger, and says it did", () => {
    const classification = classify(compiled, { channel: "webhook", event: "deployment_status" })
    expect(classification.output).toStrictEqual({ eventType: "notification", priority: 3 })
    expect(classification.matched).toBe(false)
  })

  it("does not confuse a webhook trigger with a notification trigger of the same vocabulary", () => {
    expect(classify(compiled, { channel: "webhook", reason: "mention" }).matched).toBe(false)
    expect(classify(compiled, { channel: "notification", reason: "mention" }).matched).toBe(true)
  })

  it("marks a rule matched even when its output happens to equal the fallback", () => {
    const withFallbackShapedRule = compileMappingConfig({
      ...mapping,
      rules: [{ trigger: { channel: "webhook", event: "ping" }, output: { eventType: "notification", priority: 3 } }]
    })
    expect(classify(withFallbackShapedRule, { channel: "webhook", event: "ping" }).matched).toBe(true)
  })

  it("still returns the match-key it looked up, so an edge can log which rule was sought", () => {
    expect(classify(compiled, { channel: "notification", reason: "assign" }).matchKey).toBe("notification:reason=assign")
  })
})
