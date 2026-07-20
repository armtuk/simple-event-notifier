export { matchKey, matchKeyChannelSeparator, matchKeyFieldSeparator, type Trigger, TriggerSchema } from "./channel.ts"
export { type Classification, classify } from "./classify.ts"
export { type CompiledConfig, compileMappingConfig } from "./compile.ts"
export { readConfigFile } from "./config-file.ts"
export { ConfigParseError, type IntegrationConfigError, TransformError, UnknownProcessorError } from "./errors.ts"
export { type LoadOptions, loadMappingConfig } from "./loader.ts"
export {
  type MappingConfig,
  MappingConfigSchema,
  type MappingRule,
  MappingRuleSchema,
  type Output,
  OutputSchema
} from "./mapping-config.ts"
export { type NormalizedEvent, NormalizedEventSchema } from "./normalized-event.ts"
export type { SecondaryProcessor } from "./secondary-processor.ts"
export type { SourceAdapter } from "./source-adapter.ts"
export { transform } from "./transform.ts"
