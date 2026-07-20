import { startDaemon } from "./daemon.ts"

/**
 * The process entry point, and the only module that touches `process.env` or process signals — so
 * everything else in this app is exercisable from a spec without either.
 *
 * `SIGINT`/`SIGTERM` abort one shared controller, which every source loop observes: an in-flight
 * cycle finishes its current write rather than being killed mid-batch, and no further tick is
 * scheduled. Railway sends `SIGTERM` on redeploy, so this is the ordinary path, not the exceptional
 * one.
 */

const started = await startDaemon({ env: process.env })

const shutdown = (signal: NodeJS.Signals): void => {
  started.logger.info("shutting down", { signal })
  started.stop()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
