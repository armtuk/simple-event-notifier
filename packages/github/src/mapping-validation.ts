import { Either, ParseResult, Schema } from "effect"
import { GithubConfigError } from "./errors.ts"
import { GithubTriggerSchema } from "./github-trigger.ts"

/**
 * The GitHub-specific gate on a mapping config, run **before** the framework's generic one.
 *
 * `integration-core`'s trigger schema has to stay open — it hosts providers it has never seen — so
 * it will happily accept `{ "channel": "webook", "event": "push" }` or a notification rule carrying
 * a webhook's `action`. Those rules compile to a match-key nothing ever produces, so they validate,
 * deploy, and quietly never fire. That is the worst failure mode a config-driven system has.
 *
 * This decodes every rule's trigger against the real `Schema.Union` with `onExcessProperty: "error"`,
 * turning "a rule that can never match" into a start-up failure naming the offending trigger.
 */

const RuleListSchema = /*#__PURE__*/ Schema.Struct({ rules: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })) })

const decodeRuleList = /*#__PURE__*/ Schema.decodeUnknownEither(RuleListSchema, { errors: "all" })

const decodeStrictTrigger = /*#__PURE__*/ Schema.decodeUnknownEither(GithubTriggerSchema, { errors: "all", onExcessProperty: "error" })

export const validateGithubTriggers = (raw: unknown): Either.Either<unknown, GithubConfigError> =>
  Either.flatMap(readRules(raw), rules => rejectUnproducibleTriggers(rules, raw))

const readRules = (raw: unknown): Either.Either<readonly Record<string, unknown>[], GithubConfigError> =>
  Either.map(
    Either.mapLeft(
      decodeRuleList(raw),
      error => new GithubConfigError({ reason: ParseResult.TreeFormatter.formatErrorSync(error), offendingTriggers: [] })
    ),
    decoded => decoded.rules
  )

const rejectUnproducibleTriggers = (rules: readonly Record<string, unknown>[], raw: unknown): Either.Either<unknown, GithubConfigError> => {
  const offendingTriggers = rules
    .map(rule => rule.trigger)
    .filter(trigger => Either.isLeft(decodeStrictTrigger(trigger)))
    .map(describe)
  return offendingTriggers.length === 0
    ? Either.right(raw)
    : Either.left(
        new GithubConfigError({
          reason: `${offendingTriggers.length} mapping rule trigger(s) are not shapes GitHub can produce, so they could never match a real event`,
          offendingTriggers
        })
      )
}

const describe = (trigger: unknown): string => JSON.stringify(trigger)
