import { createLogger, format, type Logger, transports } from "winston"
import type { DeploymentEnv, LogLevel } from "./config.ts"

/**
 * One JSON object per line to stdout — which is what Railway captures and indexes, so here the
 * console stream **is** the machine-consumed record and there is no readable/JSON split to make.
 *
 * Every line carries `service`, `env` and a timestamp with milliseconds per
 * `.agents/guidance/logging.md`; the per-source loggers add `source` so a `notifications` line and
 * an `events` line are never confused in a stream that interleaves both.
 *
 * **No line ever carries a token.** The repositories are given a token and never log the object
 * they were configured with — the closest they come is reporting the *presence* of a source.
 */

export const pollerServiceName = "github-poller"

export interface LoggerOptions {
  readonly level: LogLevel
  readonly env: DeploymentEnv
}

export const createPollerLogger = ({ level, env }: LoggerOptions): Logger =>
  createLogger({
    level,
    defaultMeta: { env, service: pollerServiceName },
    format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
    transports: [new transports.Console()]
  })
