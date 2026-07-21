import { Schema } from "effect"

/**
 * The subset of a `GET /users/{username}/received_events` item this integration reads.
 *
 * The Events API is the *third* GitHub channel and the most confusing one, because its vocabulary
 * looks like the webhook vocabulary but is not: it says `PullRequestEvent`, not `pull_request`, and
 * its `action` lives one level down in `payload`. The `events_api` channel tag is what keeps a rule
 * written for one from matching the other.
 *
 * It is a genuinely lower-fidelity source than a webhook — 30 s to 6 h of latency, 30 days or 300
 * events of retention, whichever comes first — but it needs no administrative rights at all, which
 * is the entire reason the poller exists.
 *
 * `payload` is `Schema.Unknown`-valued rather than typed per event: the shapes differ by `type`, we
 * read only `action` from it, and the whole item travels as the canonical event's payload anyway.
 */

export const EventsApiActorSchema = /*#__PURE__*/ Schema.Struct({ login: Schema.NonEmptyString }).annotations({
  identifier: "GithubEventsApiActor"
})

export const EventsApiRepoSchema = /*#__PURE__*/ Schema.Struct({ name: Schema.NonEmptyString }).annotations({
  identifier: "GithubEventsApiRepo"
})

export const EventsApiPayloadSchema = /*#__PURE__*/ Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({
  identifier: "GithubEventsApiPayload"
})

export const EventsApiItemSchema = /*#__PURE__*/ Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  actor: EventsApiActorSchema,
  repo: EventsApiRepoSchema,
  payload: EventsApiPayloadSchema,
  created_at: Schema.NonEmptyString
}).annotations({ identifier: "GithubEventsApiItem" })

export type GithubEventsApiItem = typeof EventsApiItemSchema.Type

export const decodeEventsApiItem = /*#__PURE__*/ Schema.decodeUnknownEither(EventsApiItemSchema, { errors: "all" })

/** `action` is one level down and only present for some event types — `PushEvent` has none. */
export const eventsApiActionOf = (item: GithubEventsApiItem): string | undefined =>
  typeof item.payload.action === "string" && item.payload.action.length > 0 ? item.payload.action : undefined

/**
 * The natural "go and look at this" link, read defensively: the payload's shape varies by `type`,
 * and a missing link is a normal outcome rather than a failure. A `workItem` that is absent is far
 * better than one that is wrong.
 */
export const eventsApiWorkItemOf = (item: GithubEventsApiItem): string | undefined =>
  htmlUrlOf(item.payload.pull_request) ?? htmlUrlOf(item.payload.issue) ?? htmlUrlOf(item.payload.release)

const htmlUrlOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "html_url" in value && typeof value.html_url === "string" && value.html_url.length > 0
    ? value.html_url
    : undefined
