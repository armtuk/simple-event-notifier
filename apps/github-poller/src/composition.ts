import type { S3Client } from "@aws-sdk/client-s3"
import { SSMClient } from "@aws-sdk/client-ssm"
import { createS3Client, probeEventBucket, S3EventRepository } from "@personal-events/event-sink"
import { loadGithubConfig } from "@personal-events/github"
import type { CompiledConfig } from "@personal-events/integration-core"
import { Either } from "effect"
import type { Logger } from "winston"
import { configuredSources, type Environment, type PollerConfig, parsePollerConfig } from "./config.ts"
import { createPollerLogger } from "./logger.ts"
import { type PollSummary, pollOnce } from "./poll-once.ts"
import { PollerStateRepository } from "./poller-state-repository.ts"
import type { SourceDefinition } from "./source-cycle.ts"
import { eventsRepository, notificationsRepository, type SourceName, sourceNames } from "./source-repositories.ts"
import { eventsSource, notificationsSource } from "./sources.ts"
import { GithubTokenRepository } from "./token-repository.ts"

/**
 * The composition root: environment → clients → resolved tokens → one poll of every runnable source.
 * It is called once per scheduled invocation by `handler.ts`.
 *
 * **Per-source isolation is the design.** A source with no configured token parameter is not
 * attempted; a source whose token cannot be read from SSM is dropped for this invocation with a
 * logged reason; a source that then fails to poll backs off via `notBefore`. None of these can stop
 * the other source, and none can fail the invocation — the whole reason two sources exist is that a
 * user may hold one credential and not the other.
 *
 * A fetch is bounded by an `AbortSignal.timeout`, so a hung GitHub call cannot burn the Lambda's
 * whole duration budget.
 *
 * The bucket pre-flight is `.agents/guidance/aws.md` § S3 § "Usage in Code" applied to a scheduled
 * function: it is a *report*, not a gate — a definitively-wrong bucket is an error an operator must
 * see, but an inconclusive probe (a transient 5xx, a cold VPC ENI) must not abort the invocation.
 */

export interface RunOptions {
  readonly s3Client?: S3Client
  readonly ssmClient?: SSMClient
  readonly now?: () => number
  readonly signal?: AbortSignal
  /** Injected so a spec can capture the invocation's log without parsing stdout. */
  readonly logger?: Logger
}

export const runScheduledPoll = async (env: Environment, options: RunOptions = {}): Promise<PollSummary> => {
  const config = parsePollerConfig(env)
  if (Either.isLeft(config)) {
    ;(options.logger ?? createPollerLogger({ level: "error", env: "prod" })).error("github poller cannot start", { reason: config.left })
    return { written: 0, polled: [], skipped: [] }
  }
  const logger = options.logger ?? createPollerLogger({ level: config.right.logLevel, env: config.right.env })
  const mapping = loadGithubConfig()
  if (Either.isLeft(mapping)) {
    logger.error("github poller cannot start: the mapping config is invalid", { reason: mapping.left._tag })
    return { written: 0, polled: [], skipped: [] }
  }
  return poll(config.right, mapping.right, logger, options)
}

const poll = async (config: PollerConfig, mapping: CompiledConfig, logger: Logger, options: RunOptions): Promise<PollSummary> => {
  const s3 = options.s3Client ?? createS3Client(config.region)
  const ssm = options.ssmClient ?? new SSMClient({ region: config.region })
  await reportBucketProbe(s3, config, logger)

  const sources = await resolveSources(config, mapping, new GithubTokenRepository(ssm), logger)
  if (sources.length === 0) {
    logger.warn("no runnable GitHub source this invocation; nothing to poll")
    return { written: 0, polled: [], skipped: [] }
  }
  const signal = options.signal ?? AbortSignal.timeout(config.fetchTimeoutMs)
  return pollOnce({
    state: new PollerStateRepository(s3, config.stateBucketName, config.stateKey, logger),
    sources,
    events: new S3EventRepository(s3, config.eventBucketName),
    seenCap: config.seenCap,
    logger,
    signal,
    now: options.now ?? Date.now
  })
}

/**
 * Turn each configured source into a runnable `SourceDefinition`, reading its token from SSM. A
 * source with no parameter is not configured; a source whose token fails to read is dropped with a
 * reason. The order is deterministic (notifications, then events), which `poll-once.ts` preserves.
 */
const resolveSources = async (
  config: PollerConfig,
  mapping: CompiledConfig,
  tokens: GithubTokenRepository,
  logger: Logger
): Promise<readonly SourceDefinition[]> => {
  const configured = configuredSources(config)
  const notifications = await resolveNotifications(config, mapping, tokens, logger, configured.notifications)
  const events = await resolveEvents(config, mapping, tokens, logger, configured.events)
  return [notifications, events].filter((source): source is SourceDefinition => source !== undefined)
}

const resolveNotifications = async (
  config: PollerConfig,
  mapping: CompiledConfig,
  tokens: GithubTokenRepository,
  logger: Logger,
  configured: boolean
): Promise<SourceDefinition | undefined> => {
  if (!configured) {
    logger.warn(
      "notifications source disabled: no GITHUB_NOTIFICATIONS_PAT_PARAM. This endpoint needs a CLASSIC PAT — a fine-grained one cannot call it"
    )
    return undefined
  }
  const token = await tokens.read(config.notificationsTokenParam ?? "")
  return withToken(sourceNames.notifications, token, logger, resolved =>
    notificationsSource(notificationsRepository({ baseUrl: config.githubApiBaseUrl, token: resolved }), mapping)
  )
}

const resolveEvents = async (
  config: PollerConfig,
  mapping: CompiledConfig,
  tokens: GithubTokenRepository,
  logger: Logger,
  configured: boolean
): Promise<SourceDefinition | undefined> => {
  if (!configured) {
    logger.warn("events source disabled: no GITHUB_EVENTS_PAT_PARAM")
    return undefined
  }
  const token = await tokens.read(config.eventsTokenParam ?? "")
  return withToken(sourceNames.events, token, logger, resolved =>
    eventsSource(eventsRepository({ baseUrl: config.githubApiBaseUrl, token: resolved, username: config.githubUsername }), mapping)
  )
}

const withToken = (
  source: SourceName,
  token: Either.Either<string, string>,
  logger: Logger,
  build: (token: string) => SourceDefinition
): SourceDefinition | undefined =>
  Either.match(token, {
    onLeft: (reason): undefined => {
      logger.error("source disabled: its token could not be read from SSM", { source, reason })
      return undefined
    },
    onRight: (resolved): SourceDefinition => build(resolved)
  })

const reportBucketProbe = async (s3: Parameters<typeof probeEventBucket>[0], config: PollerConfig, logger: Logger): Promise<void> => {
  const probe = await probeEventBucket(s3, config.eventBucketName)
  const reports: Record<typeof probe._tag, () => void> = {
    BucketReachable: (): void => {
      logger.info("event bucket reachable", { bucket: config.eventBucketName })
    },
    BucketUnreachable: (): void => {
      logger.error("event bucket is not usable; every write will fail until this is fixed", {
        bucket: config.eventBucketName,
        reason: probe._tag === "BucketUnreachable" ? probe.message : ""
      })
    },
    BucketProbeInconclusive: (): void => {
      logger.warn("could not confirm the event bucket; polling anyway", {
        bucket: config.eventBucketName,
        reason: probe._tag === "BucketProbeInconclusive" ? probe.message : ""
      })
    }
  }
  reports[probe._tag]()
}
