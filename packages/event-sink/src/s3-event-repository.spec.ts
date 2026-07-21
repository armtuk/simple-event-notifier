import { buildEventKey, type Event } from "@personal-events/event-model"
import { readExemplarEvent } from "@personal-events/event-model/testing"
import { describe, expect, it } from "vitest"
import { asEventBucketName } from "./bucket-names.ts"
import { S3EventRepository } from "./s3-event-repository.ts"
import { awsError, createFakeS3 } from "./testing/fake-s3.ts"

const bucket = asEventBucketName("events.prod.personal-events.fifthdimensionengineering.com")
const pullRequest = readExemplarEvent("valid-github-pull-request.json")
const agentNotification = readExemplarEvent("valid-agent-notification.json")

describe("S3EventRepository.putEvents", () => {
  it("writes one object per event, keyed by the contract's codec", async () => {
    const s3 = createFakeS3()
    const result = await new S3EventRepository(s3.client, bucket).putEvents([pullRequest, agentNotification])
    expect(result).toStrictEqual({
      _tag: "PutEventsSuccess",
      count: 2,
      keys: [buildEventKey(pullRequest), buildEventKey(agentNotification)]
    })
    expect(s3.puts.map(put => put.key)).toStrictEqual([buildEventKey(pullRequest), buildEventKey(agentNotification)])
  })

  it("writes into the configured bucket as JSON", async () => {
    const s3 = createFakeS3()
    await new S3EventRepository(s3.client, bucket).putEvents([pullRequest])
    expect(s3.puts[0]).toMatchObject({ bucket, contentType: "application/json" })
    expect(JSON.parse(s3.puts[0]?.body ?? "")).toMatchObject({ schemaVersion: 1, source: "github" })
  })

  it("makes no S3 call at all for an empty batch", async () => {
    const s3 = createFakeS3()
    const result = await new S3EventRepository(s3.client, bucket).putEvents([])
    expect(result).toStrictEqual({ _tag: "PutEventsSuccess", count: 0, keys: [] })
    expect(s3.puts).toStrictEqual([])
  })

  it("reports a typed failure naming the bucket and keys when S3 rejects, rather than throwing", async () => {
    const s3 = createFakeS3({ failOnPut: 0, failWith: awsError("AccessDenied", 403, "not authorised to PutObject") })
    const result = await new S3EventRepository(s3.client, bucket).putEvents([pullRequest])
    expect(result).toMatchObject({ _tag: "PutEventsFailure", bucket, keys: [buildEventKey(pullRequest)] })
    expect(result._tag === "PutEventsFailure" ? result.message : "").toContain("not authorised to PutObject")
  })

  it("fails the whole batch when any one write fails, so a caller cannot advance a cursor past a lost event", async () => {
    const s3 = createFakeS3({ failOnPut: 1 })
    const result = await new S3EventRepository(s3.client, bucket).putEvents([pullRequest, agentNotification])
    expect(result._tag).toBe("PutEventsFailure")
  })

  it("refuses to write an unencodable batch, and says so without calling S3", async () => {
    const s3 = createFakeS3()
    const corrupt = { ...pullRequest, priority: 99 } as Event
    const result = await new S3EventRepository(s3.client, bucket).putEvents([corrupt])
    expect(result).toMatchObject({ _tag: "PutEventsFailure", keys: [] })
    expect(result._tag === "PutEventsFailure" ? result.message : "").toContain("refusing to write 1 event(s)")
    expect(s3.puts).toStrictEqual([])
  })
})

describe("S3EventRepository.putEvents — bounded concurrency (R1-13)", () => {
  const events = [pullRequest, agentNotification, pullRequest, agentNotification, pullRequest]

  const trackingClient = (): { client: import("@aws-sdk/client-s3").S3Client; peak: () => number } => {
    let inFlight = 0
    let peak = 0
    const client = {
      send: async (): Promise<unknown> => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        return {}
      }
    }
    return { client: client as unknown as import("@aws-sdk/client-s3").S3Client, peak: () => peak }
  }

  it("never exceeds the configured concurrency, even for a page-sized batch", async () => {
    const tracking = trackingClient()
    const result = await new S3EventRepository(tracking.client, bucket, 2).putEvents(events)
    expect(result._tag).toBe("PutEventsSuccess")
    expect(tracking.peak()).toBeLessThanOrEqual(2)
  })

  it("defaults to a parallelism of 10 when none is given", async () => {
    expect(new S3EventRepository(createFakeS3().client, bucket).putConcurrency).toBe(10)
  })

  it("still fails the whole batch, all-or-nothing, when a write in a later chunk rejects", async () => {
    const s3 = createFakeS3({ failOnPut: 3 })
    const result = await new S3EventRepository(s3.client, bucket, 2).putEvents(events)
    expect(result._tag).toBe("PutEventsFailure")
  })
})
