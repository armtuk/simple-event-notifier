import { Schema } from "effect"

/**
 * The subset of a `GET /notifications` item this integration reads. It is a **slice, not a copy** —
 * the untouched item still travels as the event's `payload`, so nothing GitHub sent is lost; this
 * schema exists to prove the fields the normalizer is about to read are actually there and actually
 * strings.
 *
 * `subject.url` is nullable because it genuinely is: some reasons (a Dependabot security alert, a
 * repository-level notice) carry a subject with no addressable API resource. Declaring it non-null
 * would reject exactly the security alerts this system most wants to see.
 */

export const NotificationSubjectSchema = /*#__PURE__*/ Schema.Struct({
  title: Schema.String,
  type: Schema.NonEmptyString,
  url: Schema.NullOr(Schema.String)
}).annotations({ identifier: "GithubNotificationSubject" })

export const NotificationRepositorySchema = /*#__PURE__*/ Schema.Struct({ full_name: Schema.NonEmptyString }).annotations({
  identifier: "GithubNotificationRepository"
})

export const NotificationSchema = /*#__PURE__*/ Schema.Struct({
  id: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  updated_at: Schema.NonEmptyString,
  subject: NotificationSubjectSchema,
  repository: NotificationRepositorySchema
}).annotations({ identifier: "GithubNotification" })

export type GithubNotification = typeof NotificationSchema.Type

export const decodeNotification = /*#__PURE__*/ Schema.decodeUnknownEither(NotificationSchema, { errors: "all" })
