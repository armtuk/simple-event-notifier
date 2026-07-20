import { GetObjectCommand, paginateListObjectsV2, type S3Client } from "@aws-sdk/client-s3"

/**
 * Gather: one poll of the bucket. Keys carry a leading ISO instant, so they sort chronologically
 * and `ListObjectsV2` `StartAfter` (exclusive) gives exactly the objects written since the last
 * one processed. Ordering is by key string, never `LastModified` — clock skew between producers
 * would reorder events under a timestamp comparison.
 */

export interface PolledObject {
  readonly key: string
  readonly body: string
}

export interface PollResult {
  readonly objects: PolledObject[]
  readonly mark: string
}

export const pollOnce = async (s3: S3Client, bucket: string, mark: string): Promise<PollResult> => {
  const keys = await listKeysAfter(s3, bucket, mark)
  const objects = await Promise.all(keys.map(async key => ({ key, body: await fetchObjectBody(s3, bucket, key) })))
  return { objects, mark: advanceMark(mark, keys) }
}

/** The mark advances over every key seen, including ones that fail to parse — otherwise a single malformed object is retried forever. */
export const advanceMark = (mark: string, keys: readonly string[]): string =>
  keys.reduce((highest, key) => (key > highest ? key : highest), mark)

export const listKeysAfter = async (s3: S3Client, bucket: string, mark: string): Promise<string[]> => {
  const pages = await Array.fromAsync(paginateListObjectsV2({ client: s3 }, { Bucket: bucket, StartAfter: mark }))
  return pages.flatMap(page => (page.Contents ?? []).flatMap(object => (object.Key === undefined ? [] : [object.Key]))).toSorted()
}

export const fetchObjectBody = async (s3: S3Client, bucket: string, key: string): Promise<string> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return response.Body === undefined ? "" : response.Body.transformToString("utf-8")
}
