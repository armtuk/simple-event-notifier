import { Schema } from "effect"

/**
 * The failure channel of the integration template. Every fallible boundary returns
 * `Either<A, one of these>` rather than throwing, so a caller can branch on `_tag` and log a line
 * that names both the offending value and what was wrong with it.
 */

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
  integration: Schema.String,
  reason: Schema.String
}) {}

export class UnknownProcessorError extends Schema.TaggedError<UnknownProcessorError>()("UnknownProcessorError", {
  integration: Schema.String,
  unknownNames: Schema.Array(Schema.String),
  knownNames: Schema.Array(Schema.String)
}) {}

export class TransformError extends Schema.TaggedError<TransformError>()("TransformError", {
  integration: Schema.String,
  matchKey: Schema.String,
  reason: Schema.String
}) {}

export type IntegrationConfigError = ConfigParseError | UnknownProcessorError
