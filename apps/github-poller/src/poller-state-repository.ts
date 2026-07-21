import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { describeCause } from "@personal-events/event-model"
import type { StateBucketName } from "@personal-events/event-sink"
import { Either } from "effect"
import type { Logger } from "winston"
import { decodePollerState, emptyPollerState, type PollerState } from "./poller-state.ts"

/**
 * Where the poller's whole state lives: one S3 object, in the **operational-state bucket**.
 *
 * The invocation reads it once at the start and writes it once at the end (see `poll-once.ts`), which
 * — with the Lambda's `reserved_concurrent_executions = 1` — is what makes a single combined object
 * safe. See `poller-state.ts` for the concurrency argument in full.
 *
 * **The state bucket, never the event bucket.** `apps/desktop-notifier/src/poller.ts` lists the
 * event bucket with `StartAfter` and no prefix filter, and advances its mark to the highest key it
 * saw. `"state/…"` sorts above every `"2026-…"` event key, so a state object in the event bucket
 * would push that consumer's mark past every event that will ever exist — a silent, permanent
 * outage. The branded `StateBucketName` makes passing the wrong bucket a compile error.
 *
 * Loading never fails the invocation. A missing object is first-run; a malformed one is logged and
 * treated as first-run — the cost is re-delivering a page of recent items (which the dedupe set then
 * suppresses next time), against the alternative of a poller that will not run until someone
 * hand-edits an S3 object.
 */

export class PollerStateRepository {
  constructor(
    public client: S3Client,
    /** Branded, so the event bucket cannot be passed here — see `@personal-events/event-sink`. */
    public bucket: StateBucketName,
    public key: string,
    public logger: Logger
  ) {}

  load = async (): Promise<PollerState> =>
    this.client
      .send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }))
      .then(async response => this.parse(await bodyText(response)))
      .catch((cause: unknown) => this.recoverFromReadFailure(cause))

  save = async (state: PollerState): Promise<void> => {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key, Body: JSON.stringify(state), ContentType: "application/json" })
    )
  }

  parse = (text: string): PollerState =>
    Either.match(decodePollerState(safeJson(text)), {
      onLeft: (reason): PollerState => {
        this.logger.warn("poller state object is unreadable; starting from empty state", { bucket: this.bucket, key: this.key, reason })
        return emptyPollerState
      },
      onRight: (state): PollerState => state
    })

  /**
   * A missing object is the ordinary first run and is logged at `info`. Anything else — denied,
   * throttled, unreachable — is a `warn`, because starting from empty state after an *access* failure
   * means re-emitting recent items, which an operator should see rather than discover.
   */
  recoverFromReadFailure = (cause: unknown): PollerState => {
    const missing = isNoSuchKey(cause)
    const message = missing ? "no poller state yet; starting from empty state" : "could not read poller state; starting from empty state"
    this.logger.log(missing ? "info" : "warn", message, { bucket: this.bucket, key: this.key, reason: describeCause(cause) })
    return emptyPollerState
  }
}

const bodyText = async (response: { Body?: { transformToString: (encoding: string) => Promise<string> } }): Promise<string> =>
  response.Body === undefined ? "" : response.Body.transformToString("utf-8")

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isNoSuchKey = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (("name" in cause && (cause.name === "NoSuchKey" || cause.name === "NotFound")) || httpStatusOf(cause) === 404)

const httpStatusOf = (cause: object): number | undefined =>
  "$metadata" in cause &&
  typeof cause.$metadata === "object" &&
  cause.$metadata !== null &&
  "httpStatusCode" in cause.$metadata &&
  typeof cause.$metadata.httpStatusCode === "number"
    ? cause.$metadata.httpStatusCode
    : undefined
