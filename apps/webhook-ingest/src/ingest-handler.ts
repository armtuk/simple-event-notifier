import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda"
import type { Logger } from "winston"
import { outcomeToResponse } from "./outcome-response.ts"
import { parseRawRequest } from "./raw-request.ts"
import { type IntegrationRegistry, integrationFor, registeredSources } from "./registry.ts"
import { notFound, serverError } from "./response.ts"

/**
 * The router, and only the router: parse the request, find the integration, delegate, map the
 * outcome to a status code. Every decision that could be called *business logic* lives inside the
 * integration, which is what lets this file be identical no matter how many providers exist.
 *
 * It is a factory rather than a bare handler so the registry and logger are injected. A spec can
 * then drive the real routing with a stub integration, which is exactly the behaviour worth testing
 * — no AWS client is constructed anywhere in this module.
 */

export type IngestHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

export interface HandlerDeps {
  readonly registry: IntegrationRegistry
  readonly logger: Logger
}

export const createIngestHandler =
  ({ registry, logger }: HandlerDeps): IngestHandler =>
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const log = logger.child({ requestId: event.requestContext.requestId })
    const request = parseRawRequest(event)
    const integration = integrationFor(registry, request.path)
    if (integration === undefined) {
      log.warn("unroutable webhook path", { path: request.path, registered: registeredSources(registry) })
      return notFound()
    }
    return integration
      .handle(request)
      .then(outcome => {
        log.info("webhook handled", { source: integration.source, outcome: outcome.status })
        return outcomeToResponse(outcome)
      })
      .catch((cause: unknown) => {
        log.error("webhook integration threw", { source: integration.source, error: describeThrown(cause) })
        return serverError()
      })
  }

/**
 * An integration is contracted to return an outcome rather than throw, so reaching this is a defect
 * in the integration. Catching it anyway is the difference between one bad provider and every
 * provider: an unhandled rejection in a Lambda produces an opaque 502 and no log line of ours.
 */
const describeThrown = (cause: unknown): string => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))
