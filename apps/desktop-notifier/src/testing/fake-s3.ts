import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"

/**
 * A stand-in for `S3Client` backed by an in-memory key→body map. Test-support only.
 *
 * `.agents/tests.md` prefers a real bucket with fixtures over a fake, and
 * `poller.integration.spec.ts` is exactly that. This exists because the ordinary unit suite must
 * run with no AWS account, and because the paths worth pinning here — pagination, `StartAfter`
 * exclusivity, and a failing `send` — are awkward to provoke against real S3. It implements the
 * real command shapes, so the production `paginateListObjectsV2` / `GetObjectCommand` code path is
 * the one under test.
 */

export interface FakeS3 {
  readonly client: S3Client
  readonly requests: string[]
}

export interface FakeS3Options {
  readonly objects: Readonly<Record<string, string>>
  readonly pageSize?: number
  readonly failWith?: Error
}

export const createFakeS3 = ({ objects, pageSize = 1000, failWith }: FakeS3Options): FakeS3 => {
  const requests: string[] = []
  const send = async (command: unknown): Promise<unknown> => {
    if (failWith !== undefined) {
      throw failWith
    }
    if (command instanceof ListObjectsV2Command) {
      requests.push(`list:${command.input.StartAfter ?? ""}`)
      return listPage(objects, command.input.StartAfter, command.input.ContinuationToken, pageSize)
    }
    if (command instanceof HeadBucketCommand) {
      requests.push(`head:${command.input.Bucket ?? ""}`)
      return {}
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? ""
      requests.push(`get:${key}`)
      return { Body: { transformToString: async (): Promise<string> => objects[key] ?? "" } }
    }
    throw new Error(`FakeS3 received an unsupported command: ${String(command)}`)
  }
  // A real instance, because `paginateListObjectsV2` rejects anything that is not one; only the
  // transport (`send`) is replaced, so no request ever leaves the process.
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "fake", secretAccessKey: "fake" } })
  client.send = send as unknown as S3Client["send"]
  return { client, requests }
}

const listPage = (
  objects: Readonly<Record<string, string>>,
  startAfter: string | undefined,
  continuationToken: string | undefined,
  pageSize: number
): { Contents: { Key: string }[]; IsTruncated: boolean; NextContinuationToken?: string } => {
  const after = continuationToken ?? startAfter ?? ""
  const page = Object.keys(objects)
    .toSorted()
    .filter(key => key > after)
    .slice(0, pageSize)
  const last = page.at(-1)
  const truncated = last !== undefined && Object.keys(objects).some(key => key > last)
  return truncated
    ? { Contents: page.map(toContent), IsTruncated: true, NextContinuationToken: last }
    : { Contents: page.map(toContent), IsTruncated: false }
}

const toContent = (Key: string): { Key: string } => ({ Key })
