import type { ScheduledHandler } from "aws-lambda"
import { runScheduledPoll } from "./composition.ts"

/**
 * The Lambda entry point. An EventBridge rule fires this on a `rate(1 minute)` schedule; the handler
 * *is* one poll cycle — load state, poll each runnable source, save state — with EventBridge, not a
 * long-running loop, providing the cadence. Terraform points `handler = "handler.handler"` here.
 *
 * This is the only module that touches `process.env`, so every other module in the app is
 * exercisable from a spec without one. It never throws: a poll failure is a source that backs off,
 * not an invocation that errors, and letting the handler reject would only make EventBridge log an
 * opaque failure with none of our structured context.
 */

export const handler: ScheduledHandler = async () => {
  await runScheduledPoll(process.env)
}
