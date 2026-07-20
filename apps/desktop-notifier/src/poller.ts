import { GetObjectCommand, paginateListObjectsV2, type S3Client } from "@aws-sdk/client-s3"

/**
 * Gather: one poll of the bucket.
 *
 * `ListObjectsV2` `StartAfter` is exclusive and **lexicographic over keys** — it returns the objects
 * whose *key* sorts above the mark, which is not the same as the objects *written* since the mark
 * advanced. Keys lead with an ISO instant of fixed width (see `@personal-events/event-model` →
 * `isoInstantPattern`), so for distinct instants key order is chronological order; but that instant
 * is the **producer's** clock stamped into the name, not S3's write time.
 *
 * Two consequences a reader must not be surprised by. **An object written with a key that sorts
 * below the current mark is never re-listed, and is therefore never delivered.** That happens when
 * two events share a millisecond and are written in the order opposite to their tie-break
 * (`eventType` → `priority` → `source` → `name`, where `alert` < `notification`), and when producers
 * on different machines have skewed clocks so a slow one writes below a mark a fast one already set.
 *
 * Ordering by key rather than `LastModified` is therefore a deliberate trade, not a strictly safer
 * choice: `LastModified` is S3's single server clock and is immune to producer skew, but it is not
 * stable under re-writes (a client flipping `acknowledged` would resurface an old event) and cannot
 * be expressed as a `StartAfter`. The fix for the loss window is a lookback poll plus a
 * delivered-key set, not a switch to `LastModified` — see `feature.md` § Follow-up candidates.
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

/**
 * The mark advances over every key seen, including ones that fail to parse — otherwise a single
 * malformed object is retried forever. It is a high-water mark over the *whole key*, so it can only
 * move forward; anything later written below it is outside this function's reach (see the module
 * docblock).
 */
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
