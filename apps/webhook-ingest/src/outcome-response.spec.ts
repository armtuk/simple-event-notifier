import { describe, expect, it } from "vitest"
import { outcomeToResponse } from "./outcome-response.ts"
import type { WebhookOutcome } from "./webhook-integration.ts"

const statusOf = (outcome: WebhookOutcome): number | undefined => outcomeToResponse(outcome).statusCode

const bodyOf = (outcome: WebhookOutcome): Record<string, unknown> => JSON.parse(outcomeToResponse(outcome).body ?? "{}")

describe("outcomeToResponse", () => {
  it("accepts written events with 202", () => {
    expect(statusOf({ status: "events", count: 3 })).toBe(202)
    expect(bodyOf({ status: "events", count: 3 })).toStrictEqual({ accepted: 3 })
  })

  it("acknowledges a deliberate non-write with 200 and the reason", () => {
    expect(statusOf({ status: "ack", reason: "ping" })).toBe(200)
    expect(bodyOf({ status: "ack", reason: "duplicate delivery" })).toStrictEqual({ acknowledged: "duplicate delivery" })
  })

  it("rejects a bad signature with 401", () => {
    expect(statusOf({ status: "unauthorized" })).toBe(401)
  })

  it("rejects a malformed delivery with 400 and the reason", () => {
    expect(statusOf({ status: "bad-request", reason: "invalid json" })).toBe(400)
    expect(bodyOf({ status: "bad-request", reason: "invalid json" })).toStrictEqual({ error: "invalid json" })
  })

  it("surfaces a persist failure as 5xx, so it appears in GitHub's own delivery log for redelivery", () => {
    expect(statusOf({ status: "server-error" })).toBe(500)
  })

  it("never leaks internals to an anonymous caller in the 401 or 500 bodies", () => {
    expect(bodyOf({ status: "unauthorized" })).toStrictEqual({ error: "invalid signature" })
    expect(bodyOf({ status: "server-error" })).toStrictEqual({ error: "internal error" })
  })

  it("always answers JSON", () => {
    expect(outcomeToResponse({ status: "events", count: 1 }).headers).toStrictEqual({ "content-type": "application/json" })
  })
})
