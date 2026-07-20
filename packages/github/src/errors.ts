import { Schema } from "effect"

/**
 * A normalization failure is always about **one identifiable item**, and the log line that reports
 * it is useless without the identity — a delivery id, a notification id — because that is what an
 * operator uses to go and look at the thing that failed. Every field here exists to make that line
 * complete (`.agents/guidance/logging.md`: say what the value was and what was wrong with it).
 */

export class GithubNormalizeError extends Schema.TaggedError<GithubNormalizeError>()("GithubNormalizeError", {
  channel: Schema.String,
  itemId: Schema.String,
  descriptor: Schema.String,
  reason: Schema.String
}) {}

/**
 * A mapping rule whose trigger is not a shape GitHub can ever produce — a channel that does not
 * exist, a webhook trigger wearing a notification's `reason`, a field no channel defines. The
 * framework's trigger schema is deliberately open, so this is the only place such a rule can be
 * caught, and catching it at config load is the difference between a loud start-up failure and a
 * rule that validates cleanly and silently never fires.
 */
export class GithubConfigError extends Schema.TaggedError<GithubConfigError>()("GithubConfigError", {
  reason: Schema.String,
  offendingTriggers: Schema.Array(Schema.String)
}) {}
