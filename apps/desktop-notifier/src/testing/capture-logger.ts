import { Writable } from "node:stream"
import { format, type Logger, transports } from "winston"
import { createDaemonLogger } from "../logger.ts"

/**
 * Test-support: a real winston logger whose output is captured as the **JSON records that would be
 * persisted**, so specs assert the actual shipped log line rather than a stand-in.
 *
 * `.agents/tests.md` asks for this explicitly — *"validation that logging occurred and showed
 * records were successfully processed"* and *"ensure that any logging shows the full error message
 * … enable identification of which record failed"*. For this daemon the log line **is** the entire
 * user-visible signal that an object was skipped, so asserting only the returned state would leave
 * that acceptance criterion untested.
 *
 * Capturing through a `Stream` transport with `format.json()` — rather than a hand-rolled transport
 * subclass — means the assertions run against the same serialization the file transport uses,
 * including the `defaultMeta` (`service`, `env`) the logging guidance requires on every record.
 */

export interface CapturedLog {
  readonly level: string
  readonly message: string
  readonly [key: string]: unknown
}

export interface CapturingLogger {
  readonly logger: Logger
  readonly captured: CapturedLog[]
}

export const capturingLogger = (): CapturingLogger => {
  const captured: CapturedLog[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      captured.push(...parseRecords(String(chunk)))
      done()
    }
  })
  const logger = createDaemonLogger({ level: "debug", env: "development" })
  logger.clear()
  logger.add(new transports.Stream({ stream, format: format.json(), level: "debug" }))
  return { logger, captured }
}

export const entriesFor = (captured: readonly CapturedLog[], message: string): CapturedLog[] =>
  captured.filter(entry => entry.message === message)

const parseRecords = (chunk: string): CapturedLog[] =>
  chunk
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as CapturedLog)
