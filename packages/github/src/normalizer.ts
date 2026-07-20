import type { Event } from "@personal-events/event-model"
import { type CompiledConfig, type NormalizedEvent, type TransformError, transform } from "@personal-events/integration-core"
import { Either, ParseResult } from "effect"
import { toDotSafe } from "./dot-safe.ts"
import { GithubNormalizeError } from "./errors.ts"
import { decodeEventsApiItem, eventsApiActionOf, eventsApiWorkItemOf, type GithubEventsApiItem } from "./events-api.ts"
import { buildEventsApiTrigger, buildNotificationTrigger, buildWebhookTrigger, githubChannels } from "./github-trigger.ts"
import { toCanonicalInstant } from "./instant.ts"
import { decodeNotification, type GithubNotification } from "./notification.ts"
import { readerFor, type WebhookFacts } from "./webhook-schema-registry.ts"

/**
 * The only code in the system that knows GitHub's wire shapes, and it is **pure**. Fetching a
 * notification page, verifying an HMAC, deciding what time it is — none of that lives here; the
 * edges (AWE-156's Lambda integration, AWE-157's poller cycles) do those and hand the result in.
 *
 * That split is what makes the interesting part testable without a network: given these bytes and
 * this instant, this is the canonical event — a claim an exemplar can settle.
 */

export const githubSource = "github"

/**
 * A webhook delivery carries no field that reliably says *when the thing happened* — payloads vary,
 * and several covered events have no timestamp at all. So the edge injects `receivedAt`, which is
 * both honest (it is genuinely the moment we learned of it) and keeps this function pure.
 */
export interface WebhookInput {
  readonly eventName: string
  readonly deliveryId: string
  readonly receivedAt: string
  readonly raw: unknown
}

export const normalizeWebhook = (input: WebhookInput): Either.Either<NormalizedEvent, GithubNormalizeError> =>
  Either.flatMap(readFacts(input), facts =>
    Either.map(webhookInstant(input), timestamp => ({
      source: githubSource,
      name: webhookName(input.eventName, facts.action),
      timestamp,
      trigger: buildWebhookTrigger(input.eventName, facts.action),
      ...(facts.workItem === undefined ? {} : { workItem: facts.workItem }),
      payload: asPayload(input.raw)
    }))
  )

export const normalizeNotification = (raw: unknown): Either.Either<NormalizedEvent, GithubNormalizeError> =>
  Either.flatMap(readNotification(raw), notification =>
    Either.map(notificationInstant(notification), timestamp => ({
      source: githubSource,
      name: toDotSafe(notification.reason),
      timestamp,
      trigger: buildNotificationTrigger(notification.reason),
      ...(notification.subject.url === null ? {} : { workItem: notification.subject.url }),
      payload: asPayload(raw)
    }))
  )

/**
 * The Events API path. Its item carries a real per-item `created_at`, so unlike the webhook path
 * there is no injected clock, and unlike the notifications path the instants are genuinely distinct
 * per item — this source does **not** collapse a batch onto one millisecond.
 */
export const normalizeEventsApi = (raw: unknown): Either.Either<NormalizedEvent, GithubNormalizeError> =>
  Either.flatMap(readEventsApiItem(raw), item =>
    Either.map(eventsApiInstant(item), timestamp => {
      const action = eventsApiActionOf(item)
      const workItem = eventsApiWorkItemOf(item)
      return {
        source: githubSource,
        name: toDotSafe(action === undefined ? item.type : `${item.type}-${action}`),
        timestamp,
        trigger: buildEventsApiTrigger(item.type, action),
        ...(workItem === undefined ? {} : { workItem }),
        payload: asPayload(raw)
      }
    })
  )

/**
 * The composition an edge actually calls: normalize, then classify through the shared mapping
 * config. Curried config-first so a Lambda or a poller compiles the config once at start-up and
 * holds a per-item function.
 */
export const githubToEvent =
  (compiled: CompiledConfig) =>
  (input: WebhookInput): Either.Either<Event, GithubNormalizeError | TransformError> =>
    Either.flatMap(normalizeWebhook(input), transform(compiled))

export const githubNotificationToEvent =
  (compiled: CompiledConfig) =>
  (raw: unknown): Either.Either<Event, GithubNormalizeError | TransformError> =>
    Either.flatMap(normalizeNotification(raw), transform(compiled))

export const githubEventsApiToEvent =
  (compiled: CompiledConfig) =>
  (raw: unknown): Either.Either<Event, GithubNormalizeError | TransformError> =>
    Either.flatMap(normalizeEventsApi(raw), transform(compiled))

/**
 * `pull_request` + `opened` → `pull_request-opened`. This is only ever the **fallback** name: a
 * mapping rule's `output.name` wins when it has one, so the readable labels (`new-pull-request`)
 * live in config where an operator can change them. Deriving a pretty name from provider data in
 * code is precisely what the config exists to avoid.
 */
const webhookName = (eventName: string, action: string | undefined): string =>
  toDotSafe(action === undefined ? eventName : `${eventName}-${action}`)

const readFacts = (input: WebhookInput): Either.Either<WebhookFacts, GithubNormalizeError> =>
  Either.mapLeft(
    readerFor(input.eventName).read(input.raw),
    error =>
      new GithubNormalizeError({
        channel: githubChannels.webhook,
        itemId: input.deliveryId,
        descriptor: input.eventName,
        reason: ParseResult.TreeFormatter.formatErrorSync(error)
      })
  )

const readNotification = (raw: unknown): Either.Either<GithubNotification, GithubNormalizeError> =>
  Either.mapLeft(
    decodeNotification(raw),
    error =>
      new GithubNormalizeError({
        channel: githubChannels.notification,
        itemId: notificationIdOf(raw),
        descriptor: "notification",
        reason: ParseResult.TreeFormatter.formatErrorSync(error)
      })
  )

const webhookInstant = (input: WebhookInput): Either.Either<string, GithubNormalizeError> =>
  Either.mapLeft(
    toCanonicalInstant(input.receivedAt),
    reason => new GithubNormalizeError({ channel: githubChannels.webhook, itemId: input.deliveryId, descriptor: input.eventName, reason })
  )

const notificationInstant = (notification: GithubNotification): Either.Either<string, GithubNormalizeError> =>
  Either.mapLeft(
    toCanonicalInstant(notification.updated_at),
    reason =>
      new GithubNormalizeError({ channel: githubChannels.notification, itemId: notification.id, descriptor: notification.reason, reason })
  )

/**
 * The raw delivery, untouched, on its way to becoming the event's `payload`. A body that is not a
 * JSON object cannot be one — but by the time this runs the schema has already accepted the value
 * as a struct, so the branch is a type narrowing rather than a real decision.
 */
const asPayload = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}

const readEventsApiItem = (raw: unknown): Either.Either<GithubEventsApiItem, GithubNormalizeError> =>
  Either.mapLeft(
    decodeEventsApiItem(raw),
    error =>
      new GithubNormalizeError({
        channel: githubChannels.eventsApi,
        itemId: itemIdOf(raw),
        descriptor: "events_api",
        reason: ParseResult.TreeFormatter.formatErrorSync(error)
      })
  )

const eventsApiInstant = (item: GithubEventsApiItem): Either.Either<string, GithubNormalizeError> =>
  Either.mapLeft(
    toCanonicalInstant(item.created_at),
    reason => new GithubNormalizeError({ channel: githubChannels.eventsApi, itemId: item.id, descriptor: item.type, reason })
  )

/** A failing notification still wants to be identified in the log line, and `id` may be all that survives. */
const notificationIdOf = (raw: unknown): string => itemIdOf(raw)

const itemIdOf = (raw: unknown): string =>
  typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : "unknown"
