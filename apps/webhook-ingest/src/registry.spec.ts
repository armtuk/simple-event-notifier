import { describe, expect, it } from "vitest"
import { createRegistry, integrationFor, registeredSources } from "./registry.ts"
import { stubIntegration } from "./testing/stub-integration.ts"

const github = stubIntegration("github", { status: "ack", reason: "ping" })
const claudeCode = stubIntegration("claude-code", { status: "ack", reason: "ping" })

describe("the integration registry", () => {
  it("keys each integration by its own source name", () => {
    const registry = createRegistry([github, claudeCode])
    expect(integrationFor(registry, "github")).toBe(github)
    expect(integrationFor(registry, "claude-code")).toBe(claudeCode)
  })

  it("reports a miss as undefined rather than throwing, so the handler can 404", () => {
    expect(integrationFor(createRegistry([github]), "gitlab")).toBeUndefined()
  })

  it("is empty when nothing is registered — the state AWE-155 ships in", () => {
    expect(registeredSources(createRegistry([]))).toStrictEqual([])
  })

  it("lists what is registered, which is what makes an unroutable-path log actionable", () => {
    expect(registeredSources(createRegistry([github, claudeCode]))).toStrictEqual(["github", "claude-code"])
  })

  it("does not resolve inherited object properties as integrations", () => {
    expect(integrationFor(createRegistry([github]), "constructor")).toBeUndefined()
    expect(integrationFor(createRegistry([github]), "toString")).toBeUndefined()
  })
})
