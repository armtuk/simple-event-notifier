import { parseEvent, parseKey } from "@personal-events/event-model"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { capturingLogger, entriesFor } from "../../testing/stub-integration.ts"
import { GithubWebhookIntegration } from "./github-integration.ts"
import {
  commandsNamed,
  compiledGithubConfig,
  eventBucket,
  exemplarBody,
  type FakeAwsOptions,
  fakeAws,
  signedRequest,
  stateBucket,
  testSecret,
  unsignedRequest
} from "./testing/github-fixtures.ts"

const receivedAt = "2026-07-19T20:30:00.000Z"

const integrationWith = (options: FakeAwsOptions = {}) => {
  const aws = fakeAws(options)
  const log = capturingLogger()
  const integration = new GithubWebhookIntegration({
    secrets: aws.secrets,
    dedupe: aws.dedupe,
    events: aws.events,
    config: compiledGithubConfig,
    now: (): string => receivedAt,
    logger: log.logger
  })
  return { integration, aws, log }
}

const pullRequestBody = exemplarBody("webhook-pull_request-opened.json")

describe("GithubWebhookIntegration — the authenticated happy path", () => {
  it("verifies a real HMAC, writes one canonical event, then records the dedupe marker", async () => {
    const { integration, aws } = integrationWith()
    const outcome = await integration.handle(
      await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" })
    )
    expect(outcome).toStrictEqual({ status: "events", count: 1 })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(2)
  })

  it("writes the event into the EVENT bucket and the marker into the STATE bucket", async () => {
    const { integration, aws } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" }))
    const [eventPut, markerPut] = commandsNamed(aws.commands, "PutObjectCommand")
    expect(eventPut?.input.Bucket).toBe(eventBucket)
    expect(markerPut?.input.Bucket).toBe(stateBucket)
    expect(markerPut?.input.Key).toBe("deliveries/github/delivery-1")
  })

  it("writes an event whose key parses and whose body is a valid canonical event", async () => {
    const { integration, aws } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" }))
    const [eventPut] = commandsNamed(aws.commands, "PutObjectCommand")
    expect(Either.isRight(parseKey(String(eventPut?.input.Key)))).toBe(true)
    expect(Either.isRight(parseEvent(JSON.parse(String(eventPut?.input.Body))))).toBe(true)
  })

  it("classifies from the mapping config and stamps the injected instant", async () => {
    const { integration, aws } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" }))
    const [eventPut] = commandsNamed(aws.commands, "PutObjectCommand")
    expect(String(eventPut?.input.Key)).toBe(`${receivedAt}.notification.p5.github.new-pull-request.github-webhook.delivery-1.json`)
  })

  it("reads the secret once and reuses it across deliveries on a warm environment", async () => {
    const { integration, aws } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" }))
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-2" }))
    expect(commandsNamed(aws.commands, "GetParameterCommand")).toHaveLength(1)
  })

  it("logs the written keys and the classification", async () => {
    const { integration, log } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" }))
    expect(entriesFor(log.captured, "github delivery written")[0]).toMatchObject({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      eventType: "notification",
      priority: 5,
      name: "new-pull-request"
    })
  })
})

describe("GithubWebhookIntegration — authentication", () => {
  it("rejects a delivery with no signature header, writing nothing", async () => {
    const { integration, aws, log } = integrationWith()
    const outcome = await integration.handle(unsignedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d" }))
    expect(outcome).toStrictEqual({ status: "unauthorized" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
    expect(entriesFor(log.captured, "github delivery has no signature header; rejecting")).toHaveLength(1)
  })

  it("rejects a signature computed with a different secret", async () => {
    const { integration, aws } = integrationWith()
    const forged = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d", secret: "the-wrong-secret" })
    expect(await integration.handle(forged)).toStrictEqual({ status: "unauthorized" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
  })

  it("rejects a valid signature over a body that was then altered", async () => {
    const { integration } = integrationWith()
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d" })
    const tampered = { ...request, rawBody: request.rawBody.replace('"number":42', '"number":43') }
    expect(await integration.handle(tampered)).toStrictEqual({ status: "unauthorized" })
  })

  it("rejects a malformed signature header rather than throwing", async () => {
    const { integration } = integrationWith()
    const request = unsignedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d", signature: "not-a-signature" })
    expect(await integration.handle(request)).toStrictEqual({ status: "unauthorized" })
  })

  it("never logs the secret or the signature", async () => {
    const { integration, log } = integrationWith()
    const forged = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d", secret: "the-wrong-secret" })
    await integration.handle(forged)
    expect(JSON.stringify(log.captured)).not.toContain(testSecret)
    expect(JSON.stringify(log.captured)).not.toContain("sha256=")
  })

  it("does not consult the dedupe store before the signature is verified", async () => {
    const { integration, aws } = integrationWith()
    await integration.handle(unsignedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d" }))
    expect(commandsNamed(aws.commands, "HeadObjectCommand")).toHaveLength(0)
  })
})

describe("GithubWebhookIntegration — deliveries that are deliberately not written", () => {
  it("acknowledges a ping without writing anything or burning a dedupe marker", async () => {
    const { integration, aws } = integrationWith()
    const request = await signedRequest({ body: exemplarBody("webhook-ping.json"), eventName: "ping", deliveryId: "ping-1" })
    expect(await integration.handle(request)).toStrictEqual({ status: "ack", reason: "ping" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
    expect(commandsNamed(aws.commands, "HeadObjectCommand")).toHaveLength(0)
  })

  it("acknowledges a redelivery without writing a second event", async () => {
    const { integration, aws, log } = integrationWith({ alreadySeen: ["delivery-1"] })
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" })
    expect(await integration.handle(request)).toStrictEqual({ status: "ack", reason: "duplicate delivery" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
    expect(entriesFor(log.captured, "github duplicate delivery ignored")).toHaveLength(1)
  })

  it("refuses an authenticated delivery with no delivery id rather than writing something undedupable", async () => {
    const { integration, aws } = integrationWith()
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request" })
    expect(await integration.handle(request)).toStrictEqual({ status: "bad-request", reason: "missing delivery id" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
  })
})

describe("GithubWebhookIntegration — unmapped and malformed deliveries", () => {
  it("writes an unmapped event under the config default, and warns with the match key to add", async () => {
    const { integration, aws, log } = integrationWith()
    const request = await signedRequest({
      body: exemplarBody("webhook-unmodelled-deployment_status.json"),
      eventName: "deployment_status",
      deliveryId: "delivery-9"
    })
    expect(await integration.handle(request)).toStrictEqual({ status: "events", count: 1 })
    const [eventPut] = commandsNamed(aws.commands, "PutObjectCommand")
    expect(String(eventPut?.input.Key)).toContain(".notification.p3.github.deployment_status-created.github-webhook.delivery-9.json")
    expect(entriesFor(log.captured, "github event is not in the mapping config; classified by the default")[0]).toMatchObject({
      matchKey: "webhook:action=created&event=deployment_status"
    })
  })

  it("does not warn about a mapped event", async () => {
    const { integration, log } = integrationWith()
    await integration.handle(await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d" }))
    expect(entriesFor(log.captured, "github event is not in the mapping config; classified by the default")).toHaveLength(0)
  })

  it("rejects a body that is not JSON, after verifying it", async () => {
    const { integration, aws } = integrationWith()
    const request = await signedRequest({ body: "{ not json", eventName: "pull_request", deliveryId: "d" })
    expect(await integration.handle(request)).toStrictEqual({ status: "bad-request", reason: "invalid json" })
    expect(commandsNamed(aws.commands, "PutObjectCommand")).toHaveLength(0)
  })

  it("rejects a body that is valid JSON but fails the payload schema, naming the field", async () => {
    const { integration, log } = integrationWith()
    const request = await signedRequest({
      body: exemplarBody("invalid-webhook-pull_request-missing-html-url.json"),
      eventName: "pull_request",
      deliveryId: "d"
    })
    expect(await integration.handle(request)).toStrictEqual({ status: "bad-request", reason: "unprocessable payload" })
    expect(String(entriesFor(log.captured, "github delivery could not be normalized")[0]?.reason)).toContain("html_url")
  })
})

describe("GithubWebhookIntegration — failures that must not be masked", () => {
  it("returns 5xx and does NOT record the dedupe marker when the S3 write fails", async () => {
    const { integration, aws, log } = integrationWith({ failEventWrite: new Error("access denied") })
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" })
    expect(await integration.handle(request)).toStrictEqual({ status: "server-error" })
    expect(commandsNamed(aws.commands, "PutObjectCommand").filter(command => command.input.Bucket === stateBucket)).toHaveLength(0)
    expect(
      entriesFor(log.captured, "github delivery could not be written to S3; NOT recording dedupe so a redelivery still works")[0]
    ).toMatchObject({ level: "error", bucket: eventBucket })
  })

  it("propagates a non-NotFound dedupe error rather than treating it as 'not seen' and double-writing", async () => {
    const { integration } = integrationWith({
      failDedupeHead: Object.assign(new Error("throttled"), { $metadata: { httpStatusCode: 503 } })
    })
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "delivery-1" })
    await expect(integration.handle(request)).rejects.toThrow("throttled")
  })

  it("propagates a secret-read failure so the router answers 5xx rather than silently rejecting deliveries", async () => {
    const { integration } = integrationWith({ failSecretRead: new Error("ssm unreachable") })
    const request = await signedRequest({ body: pullRequestBody, eventName: "pull_request", deliveryId: "d" })
    await expect(integration.handle(request)).rejects.toThrow("could not read webhook secret")
  })
})
