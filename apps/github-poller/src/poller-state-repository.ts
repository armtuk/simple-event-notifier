import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { describeCause } from "@personal-events/event-model"
import { Either } from "effect"
import type { Logger } from "winston"
import { decodePollerState, emptyPollerState, type PollerState } from "./poller-state.ts"

/**
 * Where the poller's cursors live: an S3 object, in the **operational-state bucket**.
 *
 * Two decisions worth their reasons.
 *
 * **S3 rather than a Railway volume.** A volume causes downtime on every redeploy and does not
 * survive the service moving; S3 is already the system's source of record, survives anything, and
 * needs no additional infrastructure.
 *
 * **The state bucket, never the event bucket.** `apps/desktop-notifier/src/poller.ts` lists the
 * event bucket with `StartAfter` and no prefix filter, and advances its mark to the highest key it
 * saw. `"state/…"` sorts above every `"2026-…"` event key, so a state object in the event bucket
 * would push that consumer's mark past every event that will ever exist. The story plan originally
 * put it there; `infra/personal-events/state-bucket.tf` is the fix.
 *
 * Loading never fails the process. A missing object is first-run, and a malformed one is logged and
 * treated as first-run — the cost is re-delivering a page of recent items, against the alternative
 * of a service that will not start until someone hand-edits an S3 object.
 */

export class PollerStateRepository {
  constructor(
    public client: S3Client,
    public bucket: string,
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
