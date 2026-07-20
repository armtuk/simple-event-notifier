import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"

/**
 * Delivery-level idempotency, as tiny marker objects. GitHub does not automatically retry a failed
 * delivery, but an operator can redeliver one by hand for three days — and a webhook can also be
 * configured twice by accident. Either way the same `X-GitHub-Delivery` must not produce a second
 * event in permanent history.
 *
 * ## Why markers live in their own bucket
 *
 * The story's resolved decision put them under a `deliveries/` prefix **in the event bucket**. That
 * would be a catastrophic bug, and it is worth stating plainly so nobody reinstates it:
 *
 * `apps/desktop-notifier/src/poller.ts` lists the event bucket with `ListObjectsV2` `StartAfter` and
 * **no prefix filter**, then advances its high-water mark to the highest key it saw. Event keys lead
 * with a year, `"2026-…"`; `"deliveries/…"` starts with `d`, which sorts **above** every digit. So
 * the first poll that saw a marker would push the consumer's mark above every event key that will
 * ever exist, and the notifier would never deliver another event — permanently, silently, with no
 * error anywhere.
 *
 * Operational state therefore lives in a separate bucket that no consumer lists. AWE-157's poller
 * state (`state/…`, where `s` also sorts above `2`) has exactly the same problem and the same home.
 *
 * ## Why a non-`NotFound` error must reject
 *
 * `seen` returning `false` on a transient S3 error would let a redelivery through as a duplicate.
 * Rejecting instead surfaces a 5xx, which shows up in GitHub's own delivery log where an operator
 * can retry — a visible failure in place of a silent double-write.
 */

export interface DedupeOutcome {
  readonly seen: boolean
}

export class DeliveryDedupeRepository {
  constructor(
    public client: S3Client,
    public bucket: string,
    public prefix: string
  ) {}

  keyFor = (deliveryId: string): string => `${this.prefix}/${deliveryId}`

  seen = async (deliveryId: string): Promise<boolean> =>
    this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(deliveryId) }))
      .then(() => true)
      .catch((cause: unknown) => (isNotFound(cause) ? false : Promise.reject(cause)))

  /**
   * Called **only after** the events are durably written. Recording first would mean a persist
   * failure left a marker claiming the delivery was handled, so a redelivery would be acknowledged
   * without ever writing the event.
   */
  record = async (deliveryId: string, writtenKeys: readonly string[]): Promise<void> => {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(deliveryId),
        Body: JSON.stringify({ deliveryId, recordedAt: new Date().toISOString(), keys: writtenKeys }),
        ContentType: "application/json"
      })
    )
  }
}

/**
 * `HeadObject` has no response body, so the SDK cannot report a rich error: a missing object arrives
 * as `NotFound` (or `NoSuchKey`) with a 404 status. Matching on the status as well as the name means
 * an SDK rename does not quietly turn every miss into a rejection.
 */
const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (nameOf(cause) === "NotFound" || nameOf(cause) === "NoSuchKey" || httpStatusOf(cause) === 404)

const nameOf = (cause: object): string | undefined => ("name" in cause && typeof cause.name === "string" ? cause.name : undefined)

const httpStatusOf = (cause: object): number | undefined =>
  "$metadata" in cause &&
  typeof cause.$metadata === "object" &&
  cause.$metadata !== null &&
  "httpStatusCode" in cause.$metadata &&
  typeof cause.$metadata.httpStatusCode === "number"
    ? cause.$metadata.httpStatusCode
    : undefined
