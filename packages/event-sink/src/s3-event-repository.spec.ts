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
