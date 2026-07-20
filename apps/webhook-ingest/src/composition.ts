import { createS3Client, S3EventRepository } from "@personal-events/event-sink"
import { Either } from "effect"
import type { Logger } from "winston"
import { type Environment, type IngestConfig, parseIngestConfig } from "./config.ts"
import { createIngestHandler, type IngestHandler } from "./ingest-handler.ts"
import { createIngestLogger } from "./logger.ts"
import { createRegistry } from "./registry.ts"
import { serverError } from "./response.ts"
import type { WebhookIntegration } from "./webhook-integration.ts"

/**
 * The composition root: the one place that reads the environment, constructs AWS clients, and wires
 * integrations into a registry. Everything else in this app takes its collaborators as arguments.
 *
 * It runs **once per cold start**, not per invocation, so the SDK clients and the compiled mapping
 * configs are reused across warm invocations — which matters against GitHub's ~10 s delivery budget.
 *
 * A configuration failure does not throw. Throwing at module scope makes every invocation fail with
 * an opaque `Runtime.ImportModuleError` and no line of ours in the log; instead the failure is
 * captured and every request answers 500 with the reason recorded once, at construction.
 *
 * **The registry is empty in this story.** GitHub registers itself here in AWE-156. Until then every
 * `POST` 404s, which is the honest behaviour for an ingest with nothing behind it and is what the
 * handler specs assert with a stub integration.
 */

export interface IngestApp {
  readonly handler: IngestHandler
  readonly logger: Logger
}

export interface IntegrationDeps {
  readonly events: S3EventRepository
  readonly logger: Logger
  readonly config: IngestConfig
}

export type IntegrationFactory = (deps: IntegrationDeps) => readonly WebhookIntegration[]

export const noIntegrations: IntegrationFactory = () => []

export const createIngestApp = (env: Environment, integrations: IntegrationFactory = noIntegrations): IngestApp => {
  const config = parseIngestConfig(env)
  if (Either.isLeft(config)) {
    return misconfiguredApp(config.left)
  }
  const logger = createIngestLogger({ level: config.right.logLevel, env: config.right.env })
  const events = new S3EventRepository(createS3Client(config.right.region), config.right.eventBucketName)
  logger.info("webhook ingest starting", { bucket: config.right.eventBucketName, region: config.right.region })
  return {
    handler: createIngestHandler({ registry: createRegistry(integrations({ events, logger, config: config.right })), logger }),
    logger
  }
}

const misconfiguredApp = (reason: string): IngestApp => {
  const logger = createIngestLogger({ level: "error", env: "prod" })
  logger.error("webhook ingest cannot start", { reason })
  return { handler: async () => serverError(), logger }
}
