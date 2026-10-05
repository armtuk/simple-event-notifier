import type { S3Client } from "@aws-sdk/client-s3"

/**
 * An in-memory stand-in for `S3Client.send`, recording what the repository actually asked S3 to do.
 * This is not a mock of the repository — the real `PutObjectCommand` is constructed and its input is
 * asserted, so a wrong bucket, key, body or content-type is a failing spec rather than a happy one.
 *
 * `.agents/tests.md` prefers real infrastructure, and the deploy-gated rows in the story cover that
 * half. What a unit spec can settle here is the *shape* of the call, and for that a real network
 * round-trip would only add flakiness.
 */

export interface RecordedPut {
  readonly bucket: string
  readonly key: string
  readonly body: string
  readonly contentType: string
}

export interface FakeS3 {
  readonly client: S3Client
  readonly puts: RecordedPut[]
}

export interface FakeS3Options {
  /** Reject the nth (0-based) send, to exercise a partial-batch failure. Rejects every send when 0 and `failAll`. */
  readonly failOnPut?: number
  readonly failWith?: unknown
}

export const createFakeS3 = ({ failOnPut, failWith }: FakeS3Options = {}): FakeS3 => {
  const puts: RecordedPut[] = []
  const client = {
    send: async (command: { input: Record<string, unknown> }): Promise<unknown> => {
      const index = puts.length
      puts.push(toRecordedPut(command.input))
      return index === failOnPut ? Promise.reject(failWith ?? new Error("s3 unavailable")) : Promise.resolve({})
    }
  }
  return { client: client as unknown as S3Client, puts }
}

const toRecordedPut = (input: Record<string, unknown>): RecordedPut => ({
  bucket: String(input.Bucket),
  key: String(input.Key),
  body: String(input.Body),
  contentType: String(input.ContentType)
})

/** An SDK-shaped rejection, so `describeBucketFailure`'s status handling is exercised against a real shape. */
export const awsError = (name: string, httpStatusCode: number, message: string): Error & { $metadata: { httpStatusCode: number } } =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode } })
