import { Either, ParseResult, Schema } from "effect"

/**
 * Environment → typed configuration. Pure: `parseIngestConfig` takes the environment as an argument
 * rather than reading `process.env`, so it is unit-testable and the process boundary stays in the
 * composition root.
 *
 * `env` uses **the project's one environment vocabulary** — `.agents/guidance/aws.md`'s five values,
 * the same closed set the Terraform `env` variable validates against and the desktop notifier's
 * `ENV` accepts. The reason for the single spelling (and for `local` and `staging` being in it) is
 * recorded once, in `CLAUDE.md` § Documented carve-outs.
 */

export const deploymentEnvs = { local: "local", dev: "dev", qa: "qa", staging: "staging", prod: "prod" } as const

export type DeploymentEnv = (typeof deploymentEnvs)[keyof typeof deploymentEnvs]

export const logLevels = { error: "error", warn: "warn", info: "info", debug: "debug" } as const

export type LogLevel = (typeof logLevels)[keyof typeof logLevels]

export const ingestConfigDefaults = { region: "us-east-1", logLevel: logLevels.info, env: deploymentEnvs.prod } as const

const IngestConfigSchema = /*#__PURE__*/ Schema.Struct({
  eventBucketName: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  logLevel: Schema.Literal(logLevels.error, logLevels.warn, logLevels.info, logLevels.debug),
  env: Schema.Literal(deploymentEnvs.local, deploymentEnvs.dev, deploymentEnvs.qa, deploymentEnvs.staging, deploymentEnvs.prod)
}).annotations({ identifier: "IngestConfig" })

export type IngestConfig = typeof IngestConfigSchema.Type

export type Environment = Readonly<Partial<Record<string, string>>>

export const parseIngestConfig = (env: Environment): Either.Either<IngestConfig, string> =>
  Either.mapLeft(
    decodeConfig(toConfigFields(env)),
    error => `Invalid webhook-ingest configuration: ${ParseResult.TreeFormatter.formatErrorSync(error)}`
  )

/**
 * `AWS_REGION` is set by the Lambda runtime itself, so the default only matters for a local run.
 * `EVENT_BUCKET_NAME` has no default on purpose: a function that starts without knowing where to
 * write would accept deliveries and lose them.
 */
const toConfigFields = (env: Environment): Record<string, unknown> =>
  omitUndefined({
    eventBucketName: env.EVENT_BUCKET_NAME,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? ingestConfigDefaults.region,
    logLevel: env.LOG_LEVEL ?? ingestConfigDefaults.logLevel,
    env: env.ENV ?? ingestConfigDefaults.env
  })

const omitUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decodeConfig = /*#__PURE__*/ Schema.decodeUnknownEither(IngestConfigSchema, { errors: "all" })
