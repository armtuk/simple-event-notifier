import { Either } from "effect"
import type { Logger } from "winston"
import { type DaemonConfig, parseConfig } from "./config.ts"
import { runDaemon, type TickState } from "./daemon.ts"
import { createDaemonLogger, type LoggerOptions } from "./logger.ts"
import { createNotifier } from "./notify.ts"
import { createS3Client, probeBucket, probeCredentials } from "./s3-client.ts"
import { type LoadStateResult, loadState, seedMark } from "./state.ts"

/**
 * The process boundary: everything that reads the environment, installs signal handlers, or sets
 * an exit code lives here. Every module beneath it takes its inputs as arguments.
 */

const main = async (): Promise<number> => {
  const configResult = parseConfig(process.env)
  if (Either.isLeft(configResult)) {
    console.error(configResult.left)
    return 1
  }
  return start(configResult.right)
}

const start = async (config: DaemonConfig): Promise<number> => {
  const logger = createDaemonLogger(toLoggerOptions(config))
  const s3 = createS3Client(config.region)

  const credentials = await probeCredentials(s3)
  if (credentials._tag === "CredentialsUnavailable") {
    logger.error("No usable AWS credentials; the daemon cannot poll the event bucket", {
      region: config.region,
      reason: credentials.message
    })
    return 1
  }

  // Pre-flight the bucket per .agents/guidance/aws.md: a typo'd EVENT_BUCKET must fail at startup,
  // not become a process that backs off forever while looking healthy. A transport failure is a
  // different thing — it is no evidence about the bucket, and a laptop daemon started at login
  // routinely races wifi association — so it warns and continues into the normal back-off loop.
  const bucket = await probeBucket(s3, config.bucket)
  if (bucket._tag === "BucketUnreachable") {
    logger.error("The event bucket does not exist or is not readable; refusing to start", {
      bucket: config.bucket,
      region: config.region,
      reason: bucket.message
    })
    return 1
  }
  if (bucket._tag === "BucketProbeInconclusive") {
    logger.warn("Could not confirm the event bucket; starting anyway and letting the poll loop retry", {
      bucket: config.bucket,
      region: config.region,
      reason: bucket.message
    })
  }

  const initial = await resolveInitialState(logger, config)
  const controller = new AbortController()
  installShutdownHandlers(logger, controller)

  logger.info("Polling the event bucket for new events", {
    bucket: config.bucket,
    region: config.region,
    pollIntervalMs: config.pollIntervalMs,
    mark: initial.mark
  })

  const notifier = createNotifier(config.notifier)
  const dependencies = { s3, bucket: config.bucket, notifier, logger, stateFile: config.stateFile }
  const schedule = { pollIntervalMs: config.pollIntervalMs, maxBackoffMs: config.maxBackoffMs }
  const final = await runDaemon(dependencies, schedule, initial, controller.signal)
  logger.info("Stopped", { mark: final.mark })
  return 0
}

/**
 * With no prior state the daemon starts from "now": replaying the bucket's whole history as desktop
 * notifications on first run would be unusable. A backfill flag can come later.
 */
const resolveInitialState = async (logger: Logger, config: DaemonConfig): Promise<TickState> => {
  const loaded = await loadState(config.stateFile)
  logger.log(stateOutcomeLevels[loaded._tag], stateOutcomeMessages[loaded._tag], {
    stateFile: config.stateFile,
    ...(loaded._tag === "LoadStateFailure" ? { reason: loaded.message } : {})
  })
  return { mark: loaded._tag === "LoadedState" ? loaded.state.mark : seedMark(new Date()), consecutiveErrors: 0 }
}

const toLoggerOptions = ({ logLevel, env, logFile }: DaemonConfig): LoggerOptions =>
  logFile === undefined ? { level: logLevel, env } : { level: logLevel, env, logFile }

const stateOutcomeMessages: Record<LoadStateResult["_tag"], string> = {
  LoadedState: "Resuming from the stored high-water mark",
  NoState: "No stored high-water mark; starting from now rather than replaying history",
  LoadStateFailure: "Ignoring an unusable stored high-water mark and starting from now"
}

/**
 * A discarded mark is not routine: every event written between the last successful save and this
 * start is silently never notified. `.agents/guidance/logging.md` — *"warn is used when the state
 * being logged may be a problem"* — and the level is what an operator filters on. Kept as a full
 * `Record` over the union so a new outcome has to choose one.
 */
const stateOutcomeLevels: Record<LoadStateResult["_tag"], "info" | "warn"> = {
  LoadedState: "info",
  NoState: "info",
  LoadStateFailure: "warn"
}

const installShutdownHandlers = (logger: Logger, controller: AbortController): void => {
  const signals = ["SIGINT", "SIGTERM"] as const
  signals.forEach((signal): void => {
    process.once(signal, () => {
      logger.info("Shutdown signal received; finishing the current tick", { signal })
      controller.abort()
    })
  })
}

main()
  .then(code => {
    process.exitCode = code
  })
  .catch((cause: unknown) => {
    console.error("desktop-notifier terminated unexpectedly:", cause)
    process.exitCode = 1
  })
