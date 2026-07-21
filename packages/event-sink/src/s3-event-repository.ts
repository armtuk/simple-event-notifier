import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { describeCause, type Event } from "@personal-events/event-model"
import { Either } from "effect"
import type { EventBucketName } from "./bucket-names.ts"
import { type EventObject, toEventObjects } from "./encode-events.ts"

/**
 * The **only** place in the system that writes a canonical event to S3. Both producers go through
 * it — the webhook Lambda (AWE-156) and the Railway poller (AWE-157) — which is the point: the
 * object key *is* the log's index, and two implementations of it would drift into silent, permanent
 * event loss rather than a visible error.
 *
 * The Persist phase, and nothing else. Keys and bodies arrive already computed by
 * `toEventObjects`; this class turns them into `PutObject` calls and turns any rejection into a
 * typed result. It never throws, so a caller's control flow stays ordinary.
 */

export interface PutEventsSuccess {
  readonly _tag: "PutEventsSuccess"
  readonly count: number
  readonly keys: readonly string[]
}

export interface PutEventsFailure {
  readonly _tag: "PutEventsFailure"
  readonly bucket: EventBucketName
  readonly keys: readonly string[]
  readonly message: string
}

export type PutEventsResult = PutEventsSuccess | PutEventsFailure

export const eventContentType = "application/json"

/** `.agents/guidance/api-integrations.md`: the default downstream parallelism is 10. */
export const defaultPutConcurrency = 10

export class S3EventRepository {
  constructor(
    public client: S3Client,
    /** Branded, so a state-bucket name cannot be passed here by mistake — see `bucket-names.ts`. */
    public bucket: EventBucketName,
    /**
     * Max simultaneous `PutObject`s in a batch, per `.agents/guidance/api-integrations.md`'s default
     * parallelism of 10. The webhook path always writes one; the poller writes a whole page (up to
     * 50), so after a cold start or a long back-off an unbounded fan-out would open that many
     * connections at once. A caller may raise or lower it from config.
     */
    public putConcurrency: number = defaultPutConcurrency
  ) {}

  putEvents = async (events: readonly Event[]): Promise<PutEventsResult> => {
    const encoded = toEventObjects(events)
    return Either.isLeft(encoded)
      ? {
          _tag: "PutEventsFailure",
          bucket: this.bucket,
          keys: [],
          message: `refusing to write ${events.length} event(s): ${encoded.left.message}`
        }
      : this.putObjects(encoded.right)
  }

  /**
   * The batch is written in **bounded-concurrency chunks**, not one unbounded `Promise.all`. Within
   * a chunk the writes are concurrent (order is irrelevant — the object key, not write order,
   * establishes an event's place in the log); the chunks run in sequence, threaded through `reduce`
   * per `.agents/code-examples/typescript/src/looping.ts`. All-or-nothing is preserved: the first
   * rejecting chunk fails the whole batch, so a caller can never advance a cursor past an event that
   * did not land.
   */
  putObjects = async (objects: readonly EventObject[]): Promise<PutEventsResult> => {
    const keys = objects.map(object => object.key)
    return chunk(objects, this.putConcurrency)
      .reduce(
        async (chain, group) => chain.then(async () => Promise.all(group.map(object => this.putObject(object))).then(() => undefined)),
        Promise.resolve()
      )
      .then((): PutEventsResult => ({ _tag: "PutEventsSuccess", count: objects.length, keys }))
      .catch((cause: unknown): PutEventsResult => ({ _tag: "PutEventsFailure", bucket: this.bucket, keys, message: describeCause(cause) }))
  }

  putObject = async ({ key, body }: EventObject): Promise<unknown> =>
    this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: eventContentType }))
}

/** Splits a batch into groups of at most `size`, so writes fan out bounded rather than all-at-once. */
const chunk = <T>(items: readonly T[], size: number): readonly T[][] =>
  items.length === 0
    ? []
    : Array.from({ length: Math.ceil(items.length / Math.max(1, size)) }, (_unused, index) =>
        items.slice(index * size, index * size + size)
      )
