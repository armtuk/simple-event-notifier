import { describe, expect, it } from "vitest"
import { createIngestApp } from "./composition.ts"
import { proxyEvent, stubIntegration } from "./testing/stub-integration.ts"

const complete = { EVENT_BUCKET_NAME: "events.prod.personal-events.fifthdimensionengineering.com", AWS_REGION: "us-east-1" }

describe("createIngestApp", () => {
  it("builds a handler that 404s every POST while the registry is empty — this story's shipped state", async () => {
    const app = createIngestApp(complete)
    expect((await app.handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(404)
  })

  it("injects the shared S3 repository into whatever integrations are registered", () => {
    const seen: string[] = []
    createIngestApp(complete, ({ events }) => {
      seen.push(events.bucket)
      return []
    })
    expect(seen).toStrictEqual([complete.EVENT_BUCKET_NAME])
  })

  it("routes to a registered integration", async () => {
    const app = createIngestApp(complete, () => [stubIntegration("github", { status: "events", count: 1 })])
    expect((await app.handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(202)
  })

  it("answers 500 on a misconfigured function rather than failing to import, which logs nothing of ours", async () => {
    const app = createIngestApp({})
    expect((await app.handler(proxyEvent({ integration: "github", body: "{}" }))).statusCode).toBe(500)
  })

  it("does not construct an S3 client when configuration is invalid", () => {
    let built = false
    createIngestApp({}, () => {
      built = true
      return []
    })
    expect(built).toBe(false)
  })
})
