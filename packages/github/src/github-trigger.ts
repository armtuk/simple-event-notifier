import type { Trigger } from "@personal-events/integration-core"
import { Schema } from "effect"

/**
 * GitHub speaks through **three** channels whose vocabularies overlap but do not agree. A webhook
 * says `pull_request` + `review_requested`; the Notifications inbox says `reason: review_requested`;
 * the Events API says `PullRequestEvent` + `review_requested`. The same words, three different
 * meanings — so a rule written for one must never match another.
 *
 * The framework's `Trigger` is deliberately open (`channel` + arbitrary string fields), which is
 * what lets it host providers it has never seen. That openness is exactly wrong for *this* file: the
 * whole point here is that the three shapes are non-confusable. So GitHub declares a real
 * `Schema.Union` of literal-tagged structs, and every trigger it builds decodes to the framework's
 * open shape. Compile-time exhaustiveness for us, one lookup key for the framework.
 */

export const githubChannels = { webhook: "webhook", notification: "notification", eventsApi: "events_api" } as const

export type GithubChannel = (typeof githubChannels)[keyof typeof githubChannels]

export const WebhookTriggerSchema = /*#__PURE__*/ Schema.Struct({
  channel: Schema.Literal(githubChannels.webhook),
  event: Schema.NonEmptyString,
  action: Schema.optionalWith(Schema.NonEmptyString, { exact: true })
}).annotations({ identifier: "GithubWebhookTrigger" })

export type WebhookTrigger = typeof WebhookTriggerSchema.Type

/**
 * `reason` alone — deliberately **not** `reason` + `subjectType`, which the story stub proposed.
 *
 * The framework matches a trigger by an *exact* match-key over all its fields, so a trigger
 * carrying a field no rule mentions matches nothing. GitHub always sends `subject.type`, and
 * essentially no rule wants to discriminate on it, so including it would mean every rule had to
 * enumerate every subject type — or match nothing at all. Leaving it out of the *schema* as well as
 * the builder makes the limit **loud**: a rule written with `subjectType` fails config validation
 * with a message naming the field, instead of validating cleanly and silently never firing.
 *
 * Discriminating on subject type needs a specificity ladder in `integration-core` (try the
 * most-specific key, then fall back to less-specific ones). That is a framework change with a blast
 * radius across every integration, so it is recorded as a follow-up in
 * `.agents/plans/github-integration/feature.md` rather than taken here. The subject type is not
 * lost either way — it rides in the event's `payload`.
 */
export const NotificationTriggerSchema = /*#__PURE__*/ Schema.Struct({
  channel: Schema.Literal(githubChannels.notification),
  reason: Schema.NonEmptyString
}).annotations({ identifier: "GithubNotificationTrigger" })

export type NotificationTrigger = typeof NotificationTriggerSchema.Type

/**
 * Declared here so the union is complete from the start; the Events API source itself is AWE-157's
 * to build. Nothing constructs one of these yet, and no mapping rule uses the channel.
 */
export const EventsApiTriggerSchema = /*#__PURE__*/ Schema.Struct({
  channel: Schema.Literal(githubChannels.eventsApi),
  type: Schema.NonEmptyString,
  action: Schema.optionalWith(Schema.NonEmptyString, { exact: true })
}).annotations({ identifier: "GithubEventsApiTrigger" })

export type EventsApiTrigger = typeof EventsApiTriggerSchema.Type

export const GithubTriggerSchema = /*#__PURE__*/ Schema.Union(
  WebhookTriggerSchema,
  NotificationTriggerSchema,
  EventsApiTriggerSchema
).annotations({ identifier: "GithubTrigger" })

export type GithubTrigger = typeof GithubTriggerSchema.Type

/**
 * The builders omit an absent optional **entirely** rather than setting it to `undefined`. That is
 * not tidiness: `matchKey` renders whatever keys are present, so `{ event: "push" }` and
 * `{ event: "push", action: undefined }` would produce different lookup keys, and a `push` event
 * would then silently miss the `push` rule an operator wrote without an action.
 */
export const buildWebhookTrigger = (event: string, action: string | undefined): Trigger => ({
  channel: githubChannels.webhook,
  event,
  ...(action === undefined ? {} : { action })
})

export const buildNotificationTrigger = (reason: string): Trigger => ({ channel: githubChannels.notification, reason })

export const buildEventsApiTrigger = (type: string, action: string | undefined): Trigger => ({
  channel: githubChannels.eventsApi,
  type,
  ...(action === undefined ? {} : { action })
})
