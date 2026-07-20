import { Either, ParseResult, Schema } from "effect"

/**
 * Environment → typed configuration, pure (the environment is an argument, not `process.env`).
 *
 * The interesting part is **per-source enablement**. The two sources need *different credentials*:
 * `GET /notifications` accepts a **classic** PAT only — not a fine-grained PAT, not an App token —
 * while the Events API accepts any of them. A user may plausibly hold one and not the other, so a
 * missing token disables **that source** and leaves the other running. It is never a startup
 * failure, because refusing to start would take away the working half too.
 *
 * `env` uses the project's one environment vocabulary; the reason for the single spelling is in
 * `CLAUDE.md` § Documented carve-outs.
 */

export const deploymentEnvs = { local: "local", dev: "dev", qa: "qa", staging: "staging", prod: "prod" } as const

export type DeploymentEnv = (typeof deploymentEnvs)[keyof typeof deploymentEnvs]

export const logLevels = { error: "error", warn: "warn", info: "info", debug: "debug" } as const

export type LogLevel = (typeof logLevels)[keyof typeof logLevels]

export const pollerConfigDefaults = {
  region: "us-east-1",
  logLevel: logLevels.info,
  env: deploymentEnvs.prod,
  stateKey: "state/github-poller.json",
  githubApiBaseUrl: "https://api.github.com",
  // GitHub's own `X-Poll-Interval` is 60s for the Notifications inbox and is honoured as a floor on
  // every response; this is only the interval when the header is absent.
  notificationsIntervalMs: 60_000,
  // The Events API's own latency is 30s–6h, so polling it faster than a minute buys nothing.
  eventsIntervalMs: 300_000,
  maxBackoffMs: 900_000,
  seenCap: 1_000
} as const

const PositiveInt = /*#__PURE__*/ Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

const PollerConfigSchema = /*#__PURE__*/ Schema.Struct({
  eventBucketName: Schema.NonEmptyString,
  /** Cursors and dedupe sets live in the **operational-state** bucket — never the event bucket. */
  stateBucketName: Schema.NonEmptyString,
  stateKey: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  githubApiBaseUrl: Schema.NonEmptyString,
  githubUsername: Schema.NonEmptyString,
  notificationsToken: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  eventsToken: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  notificationsIntervalMs: PositiveInt,
  eventsIntervalMs: PositiveInt,
  maxBackoffMs: PositiveInt,
  seenCap: PositiveInt,
  logLevel: Schema.Literal(logLevels.error, logLevels.warn, logLevels.info, logLevels.debug),
  env: Schema.Literal(deploymentEnvs.local, deploymentEnvs.dev, deploymentEnvs.qa, deploymentEnvs.staging, deploymentEnvs.prod)
}).annotations({ identifier: "PollerConfig" })

export type PollerConfig = typeof PollerConfigSchema.Type

export type Environment = Readonly<Partial<Record<string, string>>>

export const parsePollerConfig = (env: Environment): Either.Either<PollerConfig, string> =>
  Either.mapLeft(
    decodeConfig(toConfigFields(env)),
    error => `Invalid github-poller configuration: ${ParseResult.TreeFormatter.formatErrorSync(error)}`
  )

/** Which sources this configuration can actually run — the answer is "whichever has a token". */
export const enabledSources = (config: PollerConfig): { readonly notifications: boolean; readonly events: boolean } => ({
  notifications: config.notificationsToken !== undefined,
  events: config.eventsToken !== undefined
})

const toConfigFields = (env: Environment): Record<string, unknown> =>
  omitUndefined({
    eventBucketName: env.EVENT_BUCKET_NAME,
    stateBucketName: env.STATE_BUCKET_NAME,
    stateKey: env.STATE_KEY ?? pollerConfigDefaults.stateKey,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? pollerConfigDefaults.region,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? pollerConfigDefaults.githubApiBaseUrl,
    githubUsername: env.GITHUB_USERNAME,
    notificationsToken: env.GITHUB_NOTIFICATIONS_PAT,
    eventsToken: env.GITHUB_EVENTS_PAT,
    notificationsIntervalMs: env.NOTIFICATIONS_INTERVAL_MS ?? String(pollerConfigDefaults.notificationsIntervalMs),
    eventsIntervalMs: env.EVENTS_INTERVAL_MS ?? String(pollerConfigDefaults.eventsIntervalMs),
    maxBackoffMs: env.MAX_BACKOFF_MS ?? String(pollerConfigDefaults.maxBackoffMs),
    seenCap: env.SEEN_CAP ?? String(pollerConfigDefaults.seenCap),
    logLevel: env.LOG_LEVEL ?? pollerConfigDefaults.logLevel,
    env: env.ENV ?? pollerConfigDefaults.env
  })

/** `exactOptionalPropertyTypes` means a present-but-undefined key is not the same as an absent one. */
const omitUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decodeConfig = /*#__PURE__*/ Schema.decodeUnknownEither(PollerConfigSchema, { errors: "all" })
