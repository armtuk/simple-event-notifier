import { verify } from "@octokit/webhooks-methods"
import type { PutEventsResult, S3EventRepository } from "@personal-events/event-sink"
import { githubSource, normalizeWebhook } from "@personal-events/github"
import { type CompiledConfig, classify, type Trigger, transform } from "@personal-events/integration-core"
import { Either } from "effect"
import type { Logger } from "winston"
import type { RawRequest } from "../../raw-request.ts"
import type { WebhookIntegration, WebhookOutcome } from "../../webhook-integration.ts"
import type { DeliveryDedupeRepository } from "./delivery-dedupe-repository.ts"
import type { WebhookSecretRepository } from "./webhook-secret-repository.ts"

/**
 * The GitHub edge: authenticate, deduplicate, normalize, classify, persist, record. Every impure
 * collaborator is injected, and every pure decision is delegated to `@personal-events/github` and
 * `@personal-events/integration-core` — so what is left here is the **order of operations**, which
 * is the part where the security and idempotency properties actually live.
 *
 * The order is not incidental:
 *
 * 1. **Verify before parsing.** The HMAC is over the raw bytes GitHub sent. Parsing first and
 *    verifying a re-serialized body would reject every genuine delivery; verifying a *parsed* body
 *    would accept forged ones.
 * 2. **Ping before dedupe.** A ping carries a delivery id but nothing to write; recording it would
 *    burn a marker for an event that never existed.
 * 3. **Dedupe before work.** A redelivery must cost one `HeadObject`, not a full normalize + write.
 * 4. **Record the marker only after a durable write.** Recording first would let a persist failure
 *    leave a marker claiming success, so the redelivery an operator triggers is acknowledged and
 *    silently discarded.
 */

export const githubWebhookHeaders = { signature: "x-hub-signature-256", event: "x-github-event", delivery: "x-github-delivery" } as const

export const githubPingEvent = "ping"

export interface GithubWebhookDeps {
  readonly secrets: WebhookSecretRepository
  readonly dedupe: DeliveryDedupeRepository
  readonly events: S3EventRepository
  readonly config: CompiledConfig
  readonly now: () => string
  readonly logger: Logger
}

export class GithubWebhookIntegration implements WebhookIntegration {
  source = githubSource

  /** The config is compiled once at construction, so a delivery pays for a lookup and nothing more. */
  toEvent: ReturnType<typeof transform>

  constructor(public deps: GithubWebhookDeps) {
    this.toEvent = transform(deps.config)
  }

  handle = async (request: RawRequest): Promise<WebhookOutcome> => {
    const eventName = request.headers[githubWebhookHeaders.event] ?? ""
    const deliveryId = request.headers[githubWebhookHeaders.delivery] ?? ""
    const log = this.deps.logger.child({ deliveryId, eventName })

    if (!(await this.isAuthentic(request, log))) {
      return { status: "unauthorized" }
    }
    if (eventName === githubPingEvent) {
      log.info("github ping acknowledged")
      return { status: "ack", reason: "ping" }
    }
    if (deliveryId.length === 0) {
      log.warn("github delivery has no delivery id; refusing rather than writing an undedupable event")
      return { status: "bad-request", reason: "missing delivery id" }
    }
    if (await this.deps.dedupe.seen(deliveryId)) {
      log.info("github duplicate delivery ignored")
      return { status: "ack", reason: "duplicate delivery" }
    }
    return this.ingest(request, eventName, deliveryId, log)
  }

  /**
   * A missing header and a wrong signature are the same answer to a caller — an unauthenticated
   * request — and are logged distinctly so an operator can tell "GitHub is not signing" from "the
   * secrets disagree". Neither line ever contains the secret or the signature.
   */
  isAuthentic = async (request: RawRequest, log: Logger): Promise<boolean> => {
    const signature = request.headers[githubWebhookHeaders.signature]
    if (signature === undefined) {
      log.warn("github delivery has no signature header; rejecting")
      return false
    }
    const secret = await this.deps.secrets.get()
    const valid = await verify(secret, request.rawBody, signature)
    if (!valid) {
      log.warn("github signature did not verify; rejecting", { bodyBytes: request.rawBody.length })
    }
    return valid
  }

  ingest = async (request: RawRequest, eventName: string, deliveryId: string, log: Logger): Promise<WebhookOutcome> => {
    const parsed = parseJsonBody(request.rawBody)
    if (Either.isLeft(parsed)) {
      log.warn("github delivery body is not valid JSON", { reason: parsed.left })
      return { status: "bad-request", reason: "invalid json" }
    }
    const normalized = normalizeWebhook({ eventName, deliveryId, receivedAt: this.deps.now(), raw: parsed.right })
    if (Either.isLeft(normalized)) {
      log.warn("github delivery could not be normalized", { reason: normalized.left.reason })
      return { status: "bad-request", reason: "unprocessable payload" }
    }
    this.warnIfUnmapped(normalized.right.trigger, log)
    const event = this.toEvent(normalized.right)
    if (Either.isLeft(event)) {
      log.warn("github delivery could not be turned into a canonical event", { reason: event.left.reason })
      return { status: "bad-request", reason: "unprocessable payload" }
    }
    return this.persist(event.right, deliveryId, log)
  }

  persist = async (
    event: Parameters<S3EventRepository["putEvents"]>[0][number],
    deliveryId: string,
    log: Logger
  ): Promise<WebhookOutcome> => {
    const written = await this.deps.events.putEvents([event])
    if (written._tag === "PutEventsFailure") {
      return this.reportPersistFailure(written, log)
    }
    await this.deps.dedupe.record(deliveryId, written.keys)
    log.info("github delivery written", { keys: written.keys, eventType: event.eventType, priority: event.priority, name: event.name })
    return { status: "events", count: written.count }
  }

  reportPersistFailure = (failure: PutEventsResult & { _tag: "PutEventsFailure" }, log: Logger): WebhookOutcome => {
    log.error("github delivery could not be written to S3; NOT recording dedupe so a redelivery still works", {
      bucket: failure.bucket,
      keys: failure.keys,
      reason: failure.message
    })
    return { status: "server-error" }
  }

  /**
   * An unmapped event is **not** an error — it classifies to the config default and is written, per
   * the feature's "nothing is silently dropped" rule. It is still a config gap the operator should
   * see, so it is a `warn` naming the exact match key they would need to write a rule for.
   *
   * The trigger comes from the normalizer rather than being rebuilt from the body here: rebuilding
   * it would duplicate the extraction rules, and the duplicate would be the one that drifts.
   */
  warnIfUnmapped = (trigger: Trigger, log: Logger): void => {
    const classification = classify(this.deps.config, trigger)
    if (!classification.matched) {
      log.warn("github event is not in the mapping config; classified by the default", { matchKey: classification.matchKey })
    }
  }
}

const parseJsonBody = (rawBody: string): Either.Either<unknown, string> =>
  Either.try({
    try: (): unknown => JSON.parse(rawBody),
    catch: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
  })
