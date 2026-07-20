import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { parseIngestConfig } from "./config.ts"

const complete = { EVENT_BUCKET_NAME: "events.prod.personal-events.fifthdimensionengineering.com", AWS_REGION: "us-east-1" }

describe("parseIngestConfig", () => {
  it("reads the bucket and region the Lambda runtime supplies", () => {
    expect(Either.getOrThrow(parseIngestConfig(complete))).toStrictEqual({
      eventBucketName: complete.EVENT_BUCKET_NAME,
      region: "us-east-1",
      logLevel: "info",
      env: "prod"
    })
  })

  it("refuses to start without a bucket, rather than accepting deliveries it would lose", () => {
    const failure = Either.getOrThrow(Either.flip(parseIngestConfig({ AWS_REGION: "us-east-1" })))
    expect(failure).toContain("eventBucketName")
  })

  it("falls back to AWS_DEFAULT_REGION, then to the documented default", () => {
    expect(Either.getOrThrow(parseIngestConfig({ ...complete, AWS_REGION: undefined, AWS_DEFAULT_REGION: "eu-west-2" })).region).toBe(
      "eu-west-2"
    )
    expect(Either.getOrThrow(parseIngestConfig({ EVENT_BUCKET_NAME: complete.EVENT_BUCKET_NAME })).region).toBe("us-east-1")
  })

  it.for([["local"], ["dev"], ["qa"], ["staging"], ["prod"]])("accepts the project environment %s", ([env]) => {
    expect(Either.getOrThrow(parseIngestConfig({ ...complete, ENV: env as string })).env).toBe(env)
  })

  it("refuses an environment outside the project's one vocabulary, rather than coercing it", () => {
    expect(Either.isLeft(parseIngestConfig({ ...complete, ENV: "production" }))).toBe(true)
    expect(Either.isLeft(parseIngestConfig({ ...complete, ENV: "stage" }))).toBe(true)
  })

  it("refuses a log level winston does not know, which would silence the function", () => {
    expect(Either.isLeft(parseIngestConfig({ ...complete, LOG_LEVEL: "verbse" }))).toBe(true)
  })

  it("reports every configuration problem at once", () => {
    const failure = Either.getOrThrow(Either.flip(parseIngestConfig({ ENV: "production", LOG_LEVEL: "loud" })))
    expect(failure).toContain("eventBucketName")
    expect(failure).toContain("env")
    expect(failure).toContain("logLevel")
  })
})
