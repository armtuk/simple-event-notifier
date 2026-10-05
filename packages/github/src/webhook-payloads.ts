import { Schema } from "effect"

/**
 * One subset schema per webhook event we understand. Each validates only the fields the normalizer
 * reads — the action, and whatever URL is the natural "go and look at this" link — and each is
 * paired with its extractor in `webhook-schema-registry.ts`.
 *
 * These are **slices**. The whole raw delivery still becomes the event's `payload`: a field dropped
 * here would be a field no future consumer could recover, and S3 is permanent history. Effect's
 * `Struct` ignores excess properties by default, which is exactly the behaviour a subset wants — a
 * new field GitHub adds tomorrow must not fail today's delivery.
 *
 * Field names and types were taken from `@octokit/openapi-webhooks-types` (GitHub's own
 * OpenAPI-generated definitions); `webhook-payloads.spec.ts` asserts at compile time that a real
 * payload of each octokit type is assignable to the corresponding subset, so a rename upstream
 * breaks the build rather than a delivery.
 */

const RepositorySubset = /*#__PURE__*/ Schema.Struct({ full_name: Schema.NonEmptyString })

export const PullRequestEventSchema = /*#__PURE__*/ Schema.Struct({
  action: Schema.NonEmptyString,
  number: Schema.Number,
  pull_request: Schema.Struct({ title: Schema.String, html_url: Schema.NonEmptyString }),
  repository: RepositorySubset
}).annotations({ identifier: "GithubPullRequestEvent" })

export const PullRequestReviewEventSchema = /*#__PURE__*/ Schema.Struct({
  action: Schema.NonEmptyString,
  review: Schema.Struct({ state: Schema.NonEmptyString, html_url: Schema.NonEmptyString }),
  pull_request: Schema.Struct({ number: Schema.Number, title: Schema.String, html_url: Schema.NonEmptyString }),
  repository: RepositorySubset
}).annotations({ identifier: "GithubPullRequestReviewEvent" })

export const IssuesEventSchema = /*#__PURE__*/ Schema.Struct({
  action: Schema.NonEmptyString,
  issue: Schema.Struct({ number: Schema.Number, title: Schema.String, html_url: Schema.NonEmptyString }),
  repository: RepositorySubset
}).annotations({ identifier: "GithubIssuesEvent" })

/** `push` is the one covered event with **no** `action` — the reason `matchKey` must treat an absent field as absent. */
export const PushEventSchema = /*#__PURE__*/ Schema.Struct({
  ref: Schema.NonEmptyString,
  before: Schema.NonEmptyString,
  after: Schema.NonEmptyString,
  compare: Schema.NonEmptyString,
  repository: RepositorySubset
}).annotations({ identifier: "GithubPushEvent" })

export const ReleaseEventSchema = /*#__PURE__*/ Schema.Struct({
  action: Schema.NonEmptyString,
  release: Schema.Struct({ tag_name: Schema.NonEmptyString, html_url: Schema.NonEmptyString }),
  repository: RepositorySubset
}).annotations({ identifier: "GithubReleaseEvent" })

/**
 * The catch-all for an event GitHub sends that we have not modelled. It is permissive on purpose:
 * an unmodelled event must still be classified (to the config default) and written, never dropped
 * for being unfamiliar. What it still refuses is a body that is not an object at all, or one whose
 * `action` is not a string — that is a malformed delivery, and a 4xx is the honest answer.
 */
export const GenericWebhookSchema = /*#__PURE__*/ Schema.Struct({
  action: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  repository: Schema.optionalWith(RepositorySubset, { exact: true })
}).annotations({ identifier: "GithubGenericWebhookEvent" })
