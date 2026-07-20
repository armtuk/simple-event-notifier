import { homedir } from "node:os"
import { join } from "node:path"
import { Either, ParseResult, Schema } from "effect"

/**
 * Environment → typed configuration. Pure: `parseConfig` takes the environment as an argument
 * rather than reading `process.env` itself, so it is unit-testable and the process boundary stays
 * in `index.ts`.
 */

export const notifierKinds = { auto: "auto", toasted: "toasted", shell: "shell" } as const

export type NotifierKind = (typeof notifierKinds)[keyof typeof notifierKinds]

/**
 * The environments a log record may be stamped with.
 *
 * `.agents/guidance/logging.md` names `["dev","qa","stage","prod"]`. `local` is added because
 * `.agents/guidance/aws.md` lists it among this project's environments, and this daemon is a
 * *desktop* client whose ordinary home is a laptop — rejecting the value the project's own
 * vocabulary uses would make the tool unusable out of the box. It is an explicitly recognized
 * fifth value, not a silent fallback: an unrecognized `ENV` still fails configuration.
 */
export const deploymentEnvs = { local: "local", dev: "dev", qa: "qa", stage: "stage", prod: "prod" } as const

export type DeploymentEnv = (typeof deploymentEnvs)[keyof typeof deploymentEnvs]

/** The npm levels winston understands. Anything else silences the logger rather than erroring. */
export const logLevels = { error: "error", warn: "warn", info: "info", debug: "debug" } as const

export type LogLevel = (typeof logLevels)[keyof typeof logLevels]

export const configDefaults = {
  region: "us-east-1",
  pollIntervalMs: 30_000,
  maxBackoffMs: 300_000,
  logLevel: logLevels.info,
  env: deploymentEnvs.dev,
  notifier: notifierKinds.auto
} as const

const PositiveInt = Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

/**
 * `env` and `logLevel` are closed sets, so they are `Schema.Literal` rather than bare non-empty
 * strings. Accepting anything and silently coercing is worse than refusing to start: `ENV=production`
 * would stamp every shipped log record with the wrong environment, and `LOG_LEVEL=verbse` would hand
 * winston a level it does not know, leaving the daemon running and emitting nothing.
 */
const ConfigSchema = /*#__PURE__*/ Schema.Struct({
  bucket: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  pollIntervalMs: PositiveInt,
  maxBackoffMs: PositiveInt,
  stateFile: Schema.NonEmptyString,
  logLevel: Schema.Literal(logLevels.error, logLevels.warn, logLevels.info, logLevels.debug),
  logFile: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  env: Schema.Literal(deploymentEnvs.local, deploymentEnvs.dev, deploymentEnvs.qa, deploymentEnvs.stage, deploymentEnvs.prod),
  notifier: Schema.Literal(notifierKinds.auto, notifierKinds.toasted, notifierKinds.shell)
}).annotations({ identifier: "DaemonConfig" })

export type DaemonConfig = typeof ConfigSchema.Type

export type Environment = Readonly<Partial<Record<string, string>>>

export const parseConfig = (env: Environment): Either.Either<DaemonConfig, string> =>
  Either.mapLeft(
    decodeConfig(toConfigFields(env)),
    error => `Invalid daemon configuration: ${ParseResult.TreeFormatter.formatErrorSync(error)}`
  )

/** The default state-file location follows the XDG base-directory spec, falling back to ~/.local/state. */
export const defaultStateFile = (env: Environment): string =>
  join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "personal-events", "desktop-notifier.json")

const toConfigFields = (env: Environment): Record<string, unknown> =>
  omitUndefined({
    bucket: env.EVENT_BUCKET,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? configDefaults.region,
    pollIntervalMs: env.POLL_INTERVAL_MS ?? String(configDefaults.pollIntervalMs),
    maxBackoffMs: env.MAX_BACKOFF_MS ?? String(configDefaults.maxBackoffMs),
    stateFile: env.STATE_FILE ?? defaultStateFile(env),
    logLevel: env.LOG_LEVEL ?? configDefaults.logLevel,
    logFile: env.LOG_FILE,
    env: env.ENV ?? configDefaults.env,
    notifier: env.NOTIFIER ?? configDefaults.notifier
  })

/** `exactOptionalPropertyTypes` means a present-but-undefined key is not the same as an absent one. */
const omitUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decodeConfig = /*#__PURE__*/ Schema.decodeUnknownEither(ConfigSchema, { errors: "all" })
