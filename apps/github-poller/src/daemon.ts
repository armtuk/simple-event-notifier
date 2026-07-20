import { createS3Client, probeEventBucket, S3EventRepository } from "@personal-events/event-sink"
import { loadGithubConfig } from "@personal-events/github"
import type { CompiledConfig } from "@personal-events/integration-core"
import { Either } from "effect"
import type { Logger } from "winston"
import { type Environment, enabledSources, type PollerConfig, parsePollerConfig } from "./config.ts"
import { createPollerLogger } from "./logger.ts"
import { PollerStateRepository } from "./poller-state-repository.ts"
import { runSourceCycle } from "./source-cycle.ts"
import { type RunningSourcePoller, runSourcePoller } from "./source-poller.ts"
import { eventsRepository, notificationsRepository, sourceNames } from "./source-repositories.ts"
import { eventsSource, notificationsSource } from "./sources.ts"

/**
 * The composition root: environment → clients → repositories → two independent source loops.
 *
 * **Per-source isolation is the design.** A source with no token is not started and says so once; a
 * source that is failing backs off inside its own loop. Neither can stop the other, and neither can
 * crash the process — because the whole reason this service exists is that a user may hold one
 * credential and not the other.
 *
 * The bucket pre-flight is `.agents/guidance/aws.md` § S3 § "Usage in Code" applied literally: this
 * is a long-running service, so "start-up" is unambiguous. An inconclusive probe (DNS, a 5xx, a
 * container starting before its network) is **not** treated as a misconfiguration — the loops start
 * anyway and back off, exactly as they would for any other transient failure.
 */

export interface StartedDaemon {
  readonly logger: Logger
  readonly pollers: readonly RunningSourcePoller[]
  readonly stop: () => void
}

export interface StartOptions {
  readonly env: Environment
  /** Injected so a spec can start and stop the daemon without touching process signals or real timers. */
  readonly controller?: AbortController
  readonly schedule?: (run: () => void, delayMs: number) => void
}

export const startDaemon = async ({ env, controller = new AbortController(), schedule }: StartOptions): Promise<StartedDaemon> => {
  const config = parsePollerConfig(env)
  if (Either.isLeft(config)) {
    const logger = createPollerLogger({ level: "error", env: "prod" })
    logger.error("github poller cannot start", { reason: config.left })
    return { logger, pollers: [], stop: (): void => controller.abort() }
  }
  const logger = createPollerLogger({ level: config.right.logLevel, env: config.right.env })
  const mapping = loadGithubConfig()
  if (Either.isLeft(mapping)) {
    logger.error("github poller cannot start: the mapping config is invalid", { reason: mapping.left._tag })
    return { logger, pollers: [], stop: (): void => controller.abort() }
  }
  return startSources(config.right, mapping.right, logger, controller, schedule)
}

const startSources = async (
  config: PollerConfig,
  mapping: CompiledConfig,
  logger: Logger,
  controller: AbortController,
  schedule: StartOptions["schedule"]
): Promise<StartedDaemon> => {
  const s3 = createS3Client(config.region)
  await reportBucketProbe(s3, config, logger)
  const events = new S3EventRepository(s3, config.eventBucketName)
  const state = new PollerStateRepository(s3, config.stateBucketName, config.stateKey, logger)
  const enabled = enabledSources(config)

  reportDisabledSources(enabled, logger)

  const pollers = [
    ...(config.notificationsToken === undefined
      ? []
      : [
          runSourcePoller({
            name: sourceNames.notifications,
            baseIntervalMs: config.notificationsIntervalMs,
            maxBackoffMs: config.maxBackoffMs,
            signal: controller.signal,
            logger,
            runCycle: runSourceCycle({
              source: notificationsSource(
                notificationsRepository({ baseUrl: config.githubApiBaseUrl, token: config.notificationsToken }),
                mapping
              ),
              state,
              events,
              seenCap: config.seenCap,
              logger,
              signal: controller.signal
            }),
            ...(schedule === undefined ? {} : { schedule })
          })
        ]),
    ...(config.eventsToken === undefined
      ? []
      : [
          runSourcePoller({
            name: sourceNames.events,
            baseIntervalMs: config.eventsIntervalMs,
            maxBackoffMs: config.maxBackoffMs,
            signal: controller.signal,
            logger,
            runCycle: runSourceCycle({
              source: eventsSource(
                eventsRepository({ baseUrl: config.githubApiBaseUrl, token: config.eventsToken, username: config.githubUsername }),
                mapping
              ),
              state,
              events,
              seenCap: config.seenCap,
              logger,
              signal: controller.signal
            }),
            ...(schedule === undefined ? {} : { schedule })
          })
        ])
  ]

  logger.info("github poller started", { sources: pollers.map(poller => poller.name), bucket: config.eventBucketName })
  return { logger, pollers, stop: (): void => controller.abort() }
}

/**
 * Named for what it is: a *report*, not a gate. A definitively-wrong bucket is an error an operator
 * must see, but exiting on an inconclusive probe would kill a service whose network simply was not
 * up yet — and the loops' own back-off already handles that case correctly.
 */
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
      logger.warn("could not confirm the event bucket; starting anyway and relying on back-off", {
        bucket: config.eventBucketName,
        reason: probe._tag === "BucketProbeInconclusive" ? probe.message : ""
      })
    }
  }
  reports[probe._tag]()
}

const reportDisabledSources = (enabled: ReturnType<typeof enabledSources>, logger: Logger): void => {
  if (!enabled.notifications) {
    logger.warn(
      "notifications source disabled: no GITHUB_NOTIFICATIONS_PAT. This endpoint needs a CLASSIC PAT — a fine-grained one cannot call it"
    )
  }
  if (!enabled.events) {
    logger.warn("events source disabled: no GITHUB_EVENTS_PAT")
  }
  if (!enabled.notifications && !enabled.events) {
    logger.error("no GitHub token configured; the poller will do nothing until one is set")
  }
}
