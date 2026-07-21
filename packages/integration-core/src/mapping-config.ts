import { EventTypeSchema, NoDotString, Priority } from "@personal-events/event-model"
import { Schema } from "effect"
import { TriggerSchema } from "./channel.ts"

/**
 * The declarative half of an integration: which provider triggers become which kind of canonical
 * event, at what priority, under what human-readable name. Changing whether a GitHub review request
 * is an alert or a notification is a JSON edit, not a code change — that is the whole point of the
 * template.
 *
 * The field schemas are **imported from `@personal-events/event-model`**, never restated. The 1–8
 * priority bound and the no-dot rule are properties of the canonical event contract; a second
 * declaration here would be a fork of that contract that drifts the first time either moves.
 */

export const OutputSchema = /*#__PURE__*/ Schema.Struct({
  eventType: EventTypeSchema,
  priority: Priority,
  name: Schema.optionalWith(NoDotString, { exact: true }),
  secondaryProcessing: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { exact: true })
}).annotations({ identifier: "Output" })

export type Output = typeof OutputSchema.Type

export const MappingRuleSchema = /*#__PURE__*/ Schema.Struct({ trigger: TriggerSchema, output: OutputSchema }).annotations({
  identifier: "MappingRule"
})

export type MappingRule = typeof MappingRuleSchema.Type

/**
 * `default` is mandatory, not optional. An integration that cannot say what an unrecognised trigger
 * means has no safe behaviour available to it: dropping the event loses data silently, and guessing
 * a classification in framework code is exactly the hardcoding the config exists to remove.
 */
export const MappingConfigSchema = /*#__PURE__*/ Schema.Struct({
  integration: NoDotString,
  rules: Schema.Array(MappingRuleSchema),
  default: OutputSchema
}).annotations({ identifier: "MappingConfig" })

export type MappingConfig = typeof MappingConfigSchema.Type
