import { describe, expect, it } from "vitest"
import { describeBucketFailure, probeBucket, probeCredentials } from "./s3-client.ts"
import { createFakeS3 } from "./testing/fake-s3.ts"

const withStatus = (status: number): Error => Object.assign(new Error("UnknownError"), { $metadata: { httpStatusCode: status } })

describe("probeBucket", () => {
  it("reports a reachable bucket", async () => {
    const { client } = createFakeS3({ objects: {} })
    expect((await probeBucket(client, "events.test.example.com"))._tag).toBe("BucketReachable")
  })

  it.each([
    { status: 404, why: "the bucket does not exist here" },
    { status: 403, why: "the credentials may not read it" },
    { status: 301, why: "it lives in another region" }
  ])("calls a $status definitively unreachable, because $why", async ({ status }) => {
    const { client } = createFakeS3({ objects: {}, failWith: withStatus(status) })
    expect((await probeBucket(client, "missing"))._tag).toBe("BucketUnreachable")
  })

  /**
   * A transport failure says nothing about whether the bucket exists, and a laptop daemon started at
   * login routinely races wifi association — so it must not be treated as a misconfiguration.
   */
  it.each([
    { label: "a DNS failure", cause: new Error("getaddrinfo ENOTFOUND s3.us-east-1.amazonaws.com") },
    { label: "a dropped connection", cause: new Error("socket hang up") },
    { label: "an S3 5xx", cause: withStatus(503) }
  ])("calls $label inconclusive rather than unreachable", async ({ cause }) => {
    const { client } = createFakeS3({ objects: {}, failWith: cause as Error })
    expect((await probeBucket(client, "events.test.example.com"))._tag).toBe("BucketProbeInconclusive")
  })

  it("still carries a readable reason on an inconclusive probe", async () => {
    const { client } = createFakeS3({ objects: {}, failWith: new Error("socket hang up") })
    const result = await probeBucket(client, "events.test.example.com")
    expect(result._tag === "BucketProbeInconclusive" ? result.message : "").toContain("socket hang up")
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
