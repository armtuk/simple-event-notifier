import { Either, ParseResult, Schema } from "effect"
import { type CompiledConfig, compileMappingConfig } from "./compile.ts"
import { ConfigParseError, type IntegrationConfigError, UnknownProcessorError } from "./errors.ts"
import { type MappingConfig, MappingConfigSchema } from "./mapping-config.ts"

/**
 * Pure Compute: untrusted JSON value → a `CompiledConfig` ready to classify with, or a typed
 * failure. Reading the bytes is a separate concern and lives in `config-file.ts` — this module
 * must stay callable against a config that was imported, embedded, or fetched.
 *
 * Two gates, in order. The schema gate rejects a config whose *shape* is wrong (an unknown
 * priority, a missing default). The processor gate rejects a config whose shape is fine but which
 * names a `secondaryProcessing` hook nobody implements — a silent no-op is the worst outcome
 * available here, because the operator's config says the event will be post-processed and it never
 * will be, with nothing in any log to say so.
 */

export interface LoadOptions {
  /** The `SecondaryProcessor` names this host can actually run. An empty list means "none registered". */
  readonly knownProcessors: readonly string[]
}

export const loadMappingConfig = (raw: unknown, { knownProcessors }: LoadOptions): Either.Either<CompiledConfig, IntegrationConfigError> =>
  Either.map(
    Either.flatMap(decodeConfig(raw), config => rejectUnknownProcessors(config, knownProcessors)),
    compileMappingConfig
  )

const decodeConfig = (raw: unknown): Either.Either<MappingConfig, ConfigParseError> =>
  Either.mapLeft(
    decodeMappingConfig(raw),
    error => new ConfigParseError({ integration: integrationNameOf(raw), reason: ParseResult.TreeFormatter.formatErrorSync(error) })
  )

const rejectUnknownProcessors = (
  config: MappingConfig,
  knownProcessors: readonly string[]
): Either.Either<MappingConfig, UnknownProcessorError> => {
  const unknownNames = declaredProcessors(config).filter(name => !knownProcessors.includes(name))
  return unknownNames.length === 0
    ? Either.right(config)
    : Either.left(new UnknownProcessorError({ integration: config.integration, unknownNames, knownNames: knownProcessors }))
}

/** Every distinct hook name the config asks for, across the rules and the default. */
const declaredProcessors = (config: MappingConfig): readonly string[] => [
  ...new Set([...config.rules.flatMap(rule => rule.output.secondaryProcessing ?? []), ...(config.default.secondaryProcessing ?? [])])
]

/**
 * A parse failure still wants to name *which* config failed, and the integration name is the only
 * identifying field a malformed config might still carry. It is read defensively — the value is by
 * definition not schema-valid at this point.
 */
const integrationNameOf = (raw: unknown): string =>
  typeof raw === "object" && raw !== null && "integration" in raw && typeof raw.integration === "string" ? raw.integration : "unknown"

const decodeMappingConfig = /*#__PURE__*/ Schema.decodeUnknownEither(MappingConfigSchema, { errors: "all" })
