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

export const configDefaults = {
  region: "us-east-1",
  pollIntervalMs: 30_000,
  maxBackoffMs: 300_000,
  logLevel: "info",
  env: "dev",
  notifier: notifierKinds.auto
} as const

const PositiveInt = Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

const ConfigSchema = /*#__PURE__*/ Schema.Struct({
  bucket: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  pollIntervalMs: PositiveInt,
  maxBackoffMs: PositiveInt,
  stateFile: Schema.NonEmptyString,
  logLevel: Schema.NonEmptyString,
  logFile: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  env: Schema.NonEmptyString,
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
