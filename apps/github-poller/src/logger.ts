import { createLogger, format, type Logger, transports } from "winston"
import type { DeploymentEnv, LogLevel } from "./config.ts"

/**
 * One JSON object per line to stdout — which is what CloudWatch captures for a Lambda, so the
 * console stream **is** the machine-consumed record and there is no readable/JSON split to make.
 *
 * Every line carries `service`, `env` and a timestamp with milliseconds per
 * `.agents/guidance/logging.md`; per-cycle lines add `source` so a `notifications` line and an
 * `events` line are never confused when one invocation polls both.
 *
 * **No line ever carries a token.** A token is read from SSM and passed to a source repository; the
 * closest any log line comes is naming the *SSM parameter* that failed to read, never its value.
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
