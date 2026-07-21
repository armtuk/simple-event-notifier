import { describe, expect, it } from "vitest"
import { createIngestHandler } from "./ingest-handler.ts"
import { createRegistry } from "./registry.ts"
import { capturingLogger, entriesFor, proxyEvent, stubIntegration } from "./testing/stub-integration.ts"
import type { WebhookOutcome } from "./webhook-integration.ts"

const handlerFor = (outcome: WebhookOutcome | (() => Promise<WebhookOutcome>)) => {
  const integration = stubIntegration("github", outcome)
  const log = capturingLogger()
  return { handler: createIngestHandler({ registry: createRegistry([integration]), logger: log.logger }), integration, log }
}

describe("the ingest handler as a router", () => {
  it("routes to the registered integration and returns its mapped outcome", async () => {
    const { handler, integration } = handlerFor({ status: "events", count: 1 })
    const response = await handler(proxyEvent({ integration: "github", body: '{"a":1}' }))
    expect(response.statusCode).toBe(202)
    expect(integration.calls).toHaveLength(1)
  })

  it("hands the integration the raw body untouched", async () => {
    const { handler, integration } = handlerFor({ status: "ack", reason: "ping" })
    const body = '{\n  "zen": "Design for failure."\n}'
    await handler(proxyEvent({ integration: "github", body }))
    expect(integration.calls[0]?.rawBody).toBe(body)
  })

  it.for([
    [{ status: "events", count: 2 } as WebhookOutcome, 202],
    [{ status: "ack", reason: "duplicate" } as WebhookOutcome, 200],
    [{ status: "unauthorized" } as WebhookOutcome, 401],
    [{ status: "bad-request", reason: "invalid json" } as WebhookOutcome, 400],
    [{ status: "server-error" } as WebhookOutcome, 500]
  ])("maps outcome %o to HTTP %d", async ([outcome, expected]) => {
    const { handler } = handlerFor(outcome as WebhookOutcome)
    expect((await handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(expected)
  })

  it("404s an unknown route without consulting any integration", async () => {
    const { handler, integration } = handlerFor({ status: "events", count: 1 })
    expect((await handler(proxyEvent({ integration: "gitlab", body: "{}" }))).statusCode).toBe(404)
    expect(integration.calls).toHaveLength(0)
  })

  it("404s when no integration is registered at all — the state this story ships in", async () => {
    const log = capturingLogger()
    const handler = createIngestHandler({ registry: createRegistry([]), logger: log.logger })
    expect((await handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(404)
  })

  it("logs an unroutable path with the path and what IS registered, so a typo is diagnosable", async () => {
    const { handler, log } = handlerFor({ status: "events", count: 1 })
    await handler(proxyEvent({ integration: "gitlab", body: "{}" }))
    expect(entriesFor(log.captured, "unroutable webhook path")[0]).toMatchObject({ level: "warn", path: "gitlab", registered: ["github"] })
  })

  it("stamps every record with the API Gateway request id, plus service and env", async () => {
    const { handler, log } = handlerFor({ status: "events", count: 1 })
    await handler(proxyEvent({ integration: "github", body: "{}", requestId: "abc-123" }))
    expect(log.captured.every(record => record.requestId === "abc-123")).toBe(true)
    expect(log.captured[0]).toMatchObject({ service: "webhook-ingest", env: "development" })
  })

  it("records the outcome of a handled delivery", async () => {
    const { handler, log } = handlerFor({ status: "unauthorized" })
    await handler(proxyEvent({ integration: "github", body: "{}" }))
    expect(entriesFor(log.captured, "webhook handled")[0]).toMatchObject({ source: "github", outcome: "unauthorized" })
  })

  it("answers 500 rather than an opaque 502 when an integration throws, and logs which one", async () => {
    const { handler, log } = handlerFor(async () => Promise.reject(new Error("ssm unreachable")))
    expect((await handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(500)
    expect(entriesFor(log.captured, "webhook integration threw")[0]).toMatchObject({
      level: "error",
      source: "github",
      error: "Error: ssm unreachable"
    })
  })

  it("does not leak a thrown integration's message to the caller", async () => {
    const { handler } = handlerFor(async () => Promise.reject(new Error("secret /personal-events/github/webhook-secret missing")))
    const response = await handler(proxyEvent({ integration: "github", body: "{}" }))
    expect(response.body).not.toContain("personal-events")
  })
})
