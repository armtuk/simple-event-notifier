import type { S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import { DeliveryDedupeRepository } from "./delivery-dedupe-repository.ts"
import { commandsNamed, deliveryPrefix, fakeAws, notFoundError, stateBucket } from "./testing/github-fixtures.ts"

const repositoryOver = (send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>) =>
  new DeliveryDedupeRepository({ send } as unknown as S3Client, stateBucket, deliveryPrefix)

describe("DeliveryDedupeRepository", () => {
  it("keys a marker by the delivery id under the configured prefix", () => {
    expect(fakeAws().dedupe.keyFor("abc-123")).toBe("deliveries/github/abc-123")
  })

  it("uses the state bucket, never the event bucket — a marker there would strand every consumer", () => {
    expect(fakeAws().dedupe.bucket).toBe(stateBucket)
  })

  it("reports a delivery as unseen when the marker does not exist", async () => {
    expect(await fakeAws().dedupe.seen("never-delivered")).toBe(false)
  })

  it("reports a delivery as seen when the marker exists", async () => {
    expect(await fakeAws({ alreadySeen: ["already"] }).dedupe.seen("already")).toBe(true)
  })

  it.for([["NotFound"], ["NoSuchKey"]])("treats an SDK %s as a genuine miss", async ([name]) => {
    const repository = repositoryOver(async () => Promise.reject(Object.assign(new Error("gone"), { name: name as string })))
    expect(await repository.seen("id")).toBe(false)
  })

  it("treats a bare 404 as a miss even if the SDK renames the error", async () => {
    const repository = repositoryOver(async () => Promise.reject(Object.assign(new Error(""), { $metadata: { httpStatusCode: 404 } })))
    expect(await repository.seen("id")).toBe(false)
  })

  it("REJECTS a non-NotFound error rather than reporting 'not seen', which would allow a duplicate write", async () => {
    const repository = repositoryOver(async () =>
      Promise.reject(Object.assign(new Error("throttled"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }))
    )
    await expect(repository.seen("id")).rejects.toThrow("throttled")
  })

  it("rejects an access-denied rather than silently disabling deduplication", async () => {
    const repository = repositoryOver(async () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))
    )
    await expect(repository.seen("id")).rejects.toThrow("denied")
  })

  it("records a marker carrying the delivery id and the keys that were written", async () => {
    const aws = fakeAws()
    await aws.dedupe.record("delivery-7", ["2026-07-19T20:30:00.000Z.alert.p5.github.new-pull-request.json"])
    const [put] = commandsNamed(aws.commands, "PutObjectCommand")
    expect(put?.input.Bucket).toBe(stateBucket)
    expect(put?.input.Key).toBe("deliveries/github/delivery-7")
    expect(JSON.parse(String(put?.input.Body))).toMatchObject({
      deliveryId: "delivery-7",
      keys: ["2026-07-19T20:30:00.000Z.alert.p5.github.new-pull-request.json"]
    })
  })

  it("propagates a failed record, because a marker that was not written must not look written", async () => {
    const repository = repositoryOver(async () => Promise.reject(new Error("bucket full")))
    await expect(repository.record("id", [])).rejects.toThrow("bucket full")
  })

  it("does not confuse two delivery ids sharing a prefix", async () => {
    const aws = fakeAws({ alreadySeen: ["abc"] })
    expect(await aws.dedupe.seen("abc")).toBe(true)
    expect(await aws.dedupe.seen("abcd")).toBe(false)
  })

  it("never throws for the ordinary miss path", async () => {
    const repository = repositoryOver(async () => Promise.reject(notFoundError()))
    await expect(repository.seen("id")).resolves.toBe(false)
  })
})
