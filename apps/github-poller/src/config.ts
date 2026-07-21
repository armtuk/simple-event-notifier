import { EventBucketName, StateBucketName } from "@personal-events/event-sink"
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
 * The tokens themselves are **not** in the environment: the env carries the **SSM parameter names**
 * (`*_PAT_PARAM`), and the values are read from SSM SecureStrings at invocation time, aligned with
 * how the webhook handler stores its HMAC secret. A source is "configured" when its parameter name
 * is present; whether its token can actually be read is decided per invocation in `composition.ts`.
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
  seenCap: 1_000,
  // A hung GitHub call must not burn the whole Lambda budget: the fetch is aborted after this.
  fetchTimeoutMs: 20_000
} as const

const PositiveInt = /*#__PURE__*/ Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

const PollerConfigSchema = /*#__PURE__*/ Schema.Struct({
  eventBucketName: EventBucketName,
  /** Cursors and dedupe sets live in the **operational-state** bucket — never the event bucket. */
  stateBucketName: StateBucketName,
  stateKey: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  githubApiBaseUrl: Schema.NonEmptyString,
  githubUsername: Schema.NonEmptyString,
  /** SSM parameter names, not token values. Presence enables the source; the value is read at runtime. */
  notificationsTokenParam: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  eventsTokenParam: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
  seenCap: PositiveInt,
  fetchTimeoutMs: PositiveInt,
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

/** Which sources this configuration can attempt — the answer is "whichever has a token parameter". */
export const configuredSources = (config: PollerConfig): { readonly notifications: boolean; readonly events: boolean } => ({
  notifications: config.notificationsTokenParam !== undefined,
  events: config.eventsTokenParam !== undefined
})

const toConfigFields = (env: Environment): Record<string, unknown> =>
  omitUndefined({
    eventBucketName: env.EVENT_BUCKET_NAME,
    stateBucketName: env.STATE_BUCKET_NAME,
    stateKey: env.STATE_KEY ?? pollerConfigDefaults.stateKey,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? pollerConfigDefaults.region,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? pollerConfigDefaults.githubApiBaseUrl,
    githubUsername: env.GITHUB_USERNAME,
    notificationsTokenParam: env.GITHUB_NOTIFICATIONS_PAT_PARAM,
    eventsTokenParam: env.GITHUB_EVENTS_PAT_PARAM,
    seenCap: env.SEEN_CAP ?? String(pollerConfigDefaults.seenCap),
    fetchTimeoutMs: env.FETCH_TIMEOUT_MS ?? String(pollerConfigDefaults.fetchTimeoutMs),
    logLevel: env.LOG_LEVEL ?? pollerConfigDefaults.logLevel,
    env: env.ENV ?? pollerConfigDefaults.env
  })

/** `exactOptionalPropertyTypes` means a present-but-undefined key is not the same as an absent one. */
const omitUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decodeConfig = /*#__PURE__*/ Schema.decodeUnknownEither(PollerConfigSchema, { errors: "all" })
