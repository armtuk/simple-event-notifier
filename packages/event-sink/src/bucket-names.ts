import { Schema } from "effect"

/**
 * Two bucket names that must never be interchanged, made **non-interchangeable to the compiler**.
 *
 * The rule they enforce is stated at length in `CLAUDE.md` § "The two-bucket rule" and
 * `infra/personal-events/state-bucket.tf`; the short version is that
 * `apps/desktop-notifier/src/poller.ts` lists the event bucket with `StartAfter` and **no prefix
 * filter**, then advances its high-water mark to the highest key it saw — and `deliveries/…` and
 * `state/…` both sort above every `2026-…` event key. One operational object in the event bucket
 * strands that consumer past every event that will ever exist, silently and permanently.
 *
 * Before these brands, that invariant had five documents and **zero mechanisms**: both names were
 * plain `string`, so `new S3EventRepository(client, config.stateBucketName)` compiled happily and no
 * spec on any path could see it. Now it is a type error. That matters most for the integration that
 * has not been written yet — the next author gets a compiler message instead of a comment they might
 * not read.
 *
 * They are `Schema.brand`s rather than hand-rolled intersection types so an app's config schema can
 * produce them **at the parse boundary**, which is the one place a raw environment string legitimately
 * becomes one of these. Nothing downstream needs a cast.
 */

export const EventBucketName = /*#__PURE__*/ Schema.NonEmptyString.pipe(
  Schema.brand("EventBucketName", {
    identifier: "EventBucketName",
    description: "the bucket holding canonical events, and NOTHING else — never operational state"
  })
)

export type EventBucketName = typeof EventBucketName.Type

export const StateBucketName = /*#__PURE__*/ Schema.NonEmptyString.pipe(
  Schema.brand("StateBucketName", {
    identifier: "StateBucketName",
    description: "the bucket holding operational state — dedupe markers and poller cursors — never events"
  })
)

export type StateBucketName = typeof StateBucketName.Type

/**
 * Escape hatches for tests and for a caller that genuinely has a bare string from outside a schema.
 * Deliberately verbose: `asEventBucketName(config.stateBucketName)` should look wrong when read.
 */
export const asEventBucketName = (name: string): EventBucketName => name as EventBucketName

export const asStateBucketName = (name: string): StateBucketName => name as StateBucketName
