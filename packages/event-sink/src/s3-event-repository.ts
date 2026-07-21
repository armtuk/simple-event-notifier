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

export class S3EventRepository {
  constructor(
    public client: S3Client,
    /** Branded, so a state-bucket name cannot be passed here by mistake — see `bucket-names.ts`. */
    public bucket: EventBucketName
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
   * Concurrent rather than sequential: the events in one batch are independent, and the object key
   * — not write order — is what establishes their order in the log. `Promise.all` also means one
   * rejection fails the whole batch, which is the behaviour a caller wants: a partial write with a
   * success result would let a poller advance its cursor past events that never landed.
   */
  putObjects = async (objects: readonly EventObject[]): Promise<PutEventsResult> => {
    const keys = objects.map(object => object.key)
    return Promise.all(objects.map(object => this.putObject(object)))
      .then((): PutEventsResult => ({ _tag: "PutEventsSuccess", count: objects.length, keys }))
      .catch((cause: unknown): PutEventsResult => ({ _tag: "PutEventsFailure", bucket: this.bucket, keys, message: describeCause(cause) }))
  }

  putObject = async ({ key, body }: EventObject): Promise<unknown> =>
    this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: eventContentType }))
}
