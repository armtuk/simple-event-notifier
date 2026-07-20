import { describe, expect, it } from "vitest"
import { describeBucketFailure, probeBucket, probeCredentials } from "./s3-client.ts"
import { createFakeS3 } from "./testing/fake-s3.ts"

const withStatus = (status: number): unknown => Object.assign(new Error("UnknownError"), { $metadata: { httpStatusCode: status } })

describe("probeBucket", () => {
  it("reports a reachable bucket", async () => {
    const { client } = createFakeS3({ objects: {} })
    expect((await probeBucket(client, "events.test.example.com"))._tag).toBe("BucketReachable")
  })

  it("reports an unreachable bucket rather than throwing", async () => {
    const { client } = createFakeS3({ objects: {}, failWith: new Error("NoSuchBucket") })
    const result = await probeBucket(client, "missing")
    expect(result._tag).toBe("BucketUnreachable")
    expect(result._tag === "BucketUnreachable" ? result.message : "").toContain("NoSuchBucket")
  })
})

/**
 * HeadBucket answers with a bodyless response, so the SDK's own message is `UnknownError`. The
 * pre-flight exists to tell an operator what to fix, so the status has to be translated.
 */
describe("describeBucketFailure", () => {
  it("turns a 404 into the two settings actually worth checking", () => {
    expect(describeBucketFailure(withStatus(404))).toContain("EVENT_BUCKET")
  })

  it("turns a 403 into a permissions statement", () => {
    expect(describeBucketFailure(withStatus(403))).toContain("access denied")
  })

  it("turns a 301 into a region mismatch", () => {
    expect(describeBucketFailure(withStatus(301))).toContain("AWS_REGION")
  })

  it("keeps the underlying message for an unmapped status", () => {
    expect(describeBucketFailure(withStatus(500))).toBe("HTTP 500: UnknownError")
  })

  it("falls back to the plain rendering when there is no HTTP status at all", () => {
    expect(describeBucketFailure(new Error("getaddrinfo ENOTFOUND"))).toBe("getaddrinfo ENOTFOUND")
  })
})

describe("probeCredentials", () => {
  it("reports usable credentials on a client that has them", async () => {
    const { client } = createFakeS3({ objects: {} })
    expect((await probeCredentials(client))._tag).toBe("CredentialsAvailable")
  })
})
