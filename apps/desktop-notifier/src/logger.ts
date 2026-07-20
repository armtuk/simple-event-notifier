import { createLogger, format, type Logger, transports } from "winston"
import type { DeploymentEnv, LogLevel } from "./config.ts"

/**
 * The default application logger per `.agents/guidance/logging.md`: one well-formed JSON object
 * per line to the logfile (the machine-consumed record), and a readable single line to the
 * console (the developer-facing view). Serialization is a per-destination concern over a shared
 * preprocessing step.
 *
 * `env` and `level` arrive already narrowed to their closed sets by `config.ts`, so there is no
 * coercion here — an unrecognized value fails configuration rather than silently becoming `dev` or
 * a level winston ignores.
 */

const serviceName = "desktop-notifier"

/** Winston stashes the raw per-call meta args under this symbol, distinct from the merged defaultMeta. */
const splat = Symbol.for("splat")

const baseFormat = format.combine(format.timestamp(), format.errors({ stack: true }))

const consoleFormat = format.printf((info): string => {
  const meta = info[splat] as unknown[] | undefined
  const suffix = meta !== undefined && meta.length > 0 ? ` ${meta.map(formatMeta).join(" ")}` : ""
  return `${String(info.timestamp)} ${info.level}: ${String(info.message)}${suffix}`
})

export interface LoggerOptions {
  readonly level: LogLevel
  readonly env: DeploymentEnv
  readonly logFile?: string
}

export const createDaemonLogger = ({ level, env, logFile }: LoggerOptions): Logger =>
  createLogger({
    level,
    defaultMeta: { env, service: serviceName },
    format: baseFormat,
    transports:
      logFile === undefined
        ? [new transports.Console({ format: consoleFormat })]
        : [new transports.Console({ format: consoleFormat }), new transports.File({ filename: logFile, format: format.json() })]
  })

const formatMeta = (value: unknown): string => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value))
