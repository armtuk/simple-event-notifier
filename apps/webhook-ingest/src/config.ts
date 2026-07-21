import { EventBucketName, StateBucketName } from "@personal-events/event-sink"
import { Either, ParseResult, Schema } from "effect"

/**
 * Environment → typed configuration. Pure: `parseIngestConfig` takes the environment as an argument
 * rather than reading `process.env`, so it is unit-testable and the process boundary stays in the
 * composition root.
 *
 * `env` uses **the project's environment vocabulary** — `.agents/guidance/aws.md`'s `development` /
 * `production`, the same two values the Terraform `env` variable validates against and every other
 * app's `ENV` accepts. One spelling has to win because the same value names buckets and DNS labels
 * on the Terraform side and stamps log records here.
 */

export const deploymentEnvs = { development: "development", production: "production" } as const

export type DeploymentEnv = (typeof deploymentEnvs)[keyof typeof deploymentEnvs]

export const logLevels = { error: "error", warn: "warn", info: "info", debug: "debug" } as const

export type LogLevel = (typeof logLevels)[keyof typeof logLevels]

export const ingestConfigDefaults = {
  region: "us-east-1",
  logLevel: logLevels.info,
  env: deploymentEnvs.production,
  githubWebhookSecretParam: "/personal-events/github/webhook-secret",
  githubDeliveryPrefix: "deliveries/github"
} as const

const IngestConfigSchema = /*#__PURE__*/ Schema.Struct({
  eventBucketName: EventBucketName,
  /**
   * Operational state — delivery-dedupe markers now, poller cursors later — lives in a **separate
   * bucket** from the events. It is not tidiness: `apps/desktop-notifier/src/poller.ts` lists the
   * event bucket with no prefix filter and advances its high-water mark to the highest key it saw,
   * and `"deliveries/…"` sorts above every `"2026-…"` event key. One marker in the event bucket
   * would push a consumer's mark past every event that will ever exist.
   */
  stateBucketName: StateBucketName,
  githubWebhookSecretParam: Schema.NonEmptyString,
  githubDeliveryPrefix: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  logLevel: Schema.Literal(logLevels.error, logLevels.warn, logLevels.info, logLevels.debug),
  env: Schema.Literal(deploymentEnvs.development, deploymentEnvs.production)
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
    stateBucketName: env.STATE_BUCKET_NAME,
    githubWebhookSecretParam: env.GITHUB_WEBHOOK_SECRET_PARAM ?? ingestConfigDefaults.githubWebhookSecretParam,
    githubDeliveryPrefix: env.GITHUB_DELIVERY_PREFIX ?? ingestConfigDefaults.githubDeliveryPrefix,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? ingestConfigDefaults.region,
    logLevel: env.LOG_LEVEL ?? ingestConfigDefaults.logLevel,
    env: env.ENV ?? ingestConfigDefaults.env
  })

const omitUndefined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decodeConfig = /*#__PURE__*/ Schema.decodeUnknownEither(IngestConfigSchema, { errors: "all" })
