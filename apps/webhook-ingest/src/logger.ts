import { createLogger, format, type Logger, transports } from "winston"
import type { DeploymentEnv, LogLevel } from "./config.ts"

/**
 * One JSON object per line to stdout, which is what CloudWatch captures — so unlike the desktop
 * notifier there is no readable-console/JSON-file split here: the "console" *is* the shipped record.
 *
 * Per `.agents/guidance/logging.md`, a log line inside a web request must carry a request id. API
 * Gateway supplies one on every invocation (`requestContext.requestId`), and `requestLogger` binds
 * it so every subordinate line carries it without each call site remembering to.
 */

export const ingestServiceName = "webhook-ingest"

export interface LoggerOptions {
  readonly level: LogLevel
  readonly env: DeploymentEnv
}

export const createIngestLogger = ({ level, env }: LoggerOptions): Logger =>
  createLogger({
    level,
    defaultMeta: { env, service: ingestServiceName },
    format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
    transports: [new transports.Console()]
  })

export const requestLogger = (logger: Logger, requestId: string): Logger => logger.child({ requestId })
