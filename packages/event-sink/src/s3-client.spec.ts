import type { S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import { createS3Client, describeBucketFailure, probeEventBucket } from "./s3-client.ts"
import { awsError } from "./testing/fake-s3.ts"

const bucket = "events.prod.personal-events.fifthdimensionengineering.com"

const probingClient = (outcome: () => Promise<unknown>): S3Client => ({ send: outcome }) as unknown as S3Client

describe("probeEventBucket", () => {
  it("reports a reachable bucket", async () => {
    expect(
      await probeEventBucket(
        probingClient(async () => ({})),
        bucket
      )
    ).toStrictEqual({ _tag: "BucketReachable" })
  })

  it.for([[404], [403], [301]])("treats HTTP %d as definitive evidence the configuration is wrong", async ([status]) => {
    const probe = await probeEventBucket(
      probingClient(async () => Promise.reject(awsError("UnknownError", status as number, ""))),
      bucket
    )
    expect(probe._tag).toBe("BucketUnreachable")
  })

  it("treats a 5xx as inconclusive — S3 failing is not the configuration being wrong", async () => {
    const probe = await probeEventBucket(
      probingClient(async () => Promise.reject(awsError("InternalError", 503, "slow down"))),
      bucket
    )
    expect(probe._tag).toBe("BucketProbeInconclusive")
  })

  it("treats a transport error as inconclusive, so a producer started before its network retries", async () => {
    const probe = await probeEventBucket(
      probingClient(async () => Promise.reject(new Error("getaddrinfo ENOTFOUND s3"))),
      bucket
    )
    expect(probe).toStrictEqual({ _tag: "BucketProbeInconclusive", message: "getaddrinfo ENOTFOUND s3" })
  })

  it("never throws — a rejection with a non-Error value is still a result", async () => {
    const probe = await probeEventBucket(
      probingClient(() => Promise.reject("nope")),
      bucket
    )
    expect(probe._tag).toBe("BucketProbeInconclusive")
  })
})

describe("describeBucketFailure", () => {
  it("translates a bodyless 404 into the thing an operator should actually check", () => {
    expect(describeBucketFailure(awsError("UnknownError", 404, ""))).toContain("no such bucket")
  })

  it("names the permission problem for a 403 rather than surfacing an empty SDK message", () => {
    expect(describeBucketFailure(awsError("UnknownError", 403, ""))).toContain("access denied")
  })

  it("names the region for a 301", () => {
    expect(describeBucketFailure(awsError("UnknownError", 301, ""))).toContain("different region")
  })

  it("falls back to the status and message for anything else", () => {
    expect(describeBucketFailure(awsError("InternalError", 503, "slow down"))).toBe("HTTP 503: slow down")
  })

  it("renders a plain error as its message", () => {
    expect(describeBucketFailure(new Error("socket hang up"))).toBe("socket hang up")
  })
})

describe("createS3Client", () => {
  it("builds a client for the configured region using the ambient credential chain", async () => {
    const client = createS3Client("eu-west-2")
    expect(await client.config.region()).toBe("eu-west-2")
  })
})
