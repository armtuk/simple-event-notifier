import { Writable } from "node:stream"
import type { APIGatewayProxyEventV2 } from "aws-lambda"
import { format, type Logger, transports } from "winston"
import { createIngestLogger } from "../logger.ts"
import type { RawRequest } from "../raw-request.ts"
import type { WebhookIntegration, WebhookOutcome } from "../webhook-integration.ts"

/**
 * Support for driving the **real** router. AWE-155 ships an empty registry, so the only way to prove
 * routing, delegation and the outcome→HTTP mapping actually work is a stub integration standing
 * where GitHub will stand in AWE-156. That is testing the router, not testing a mock: every line
 * under assertion is production code.
 */

export interface StubIntegration extends WebhookIntegration {
  readonly calls: RawRequest[]
}

export const stubIntegration = (source: string, outcome: WebhookOutcome | (() => Promise<WebhookOutcome>)): StubIntegration => {
  const calls: RawRequest[] = []
  return {
    source,
    calls,
    handle: async (request: RawRequest): Promise<WebhookOutcome> => {
      calls.push(request)
      return typeof outcome === "function" ? outcome() : outcome
    }
  }
}

export interface CapturedLog {
  readonly level: string
  readonly message: string
  readonly [key: string]: unknown
}

export interface CapturingLogger {
  readonly logger: Logger
  readonly captured: CapturedLog[]
}

/**
 * Captured through a real `Stream` transport with `format.json()`, mirroring
 * `apps/desktop-notifier/src/testing/capture-logger.ts`: specs then assert the exact record that
 * would reach CloudWatch — `service`, `env` and `requestId` included — rather than a stand-in shape.
 */
export const capturingLogger = (): CapturingLogger => {
  const captured: CapturedLog[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      captured.push(...parseRecords(String(chunk)))
      done()
    }
  })
  const logger = createIngestLogger({ level: "debug", env: "development" })
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

/** A minimal API Gateway v2 event — only the fields the handler reads, so a change to those is visible here. */
export const proxyEvent = (overrides: {
  readonly integration?: string
  readonly body?: string
  readonly isBase64Encoded?: boolean
  readonly headers?: Record<string, string | undefined>
  readonly requestId?: string
}): APIGatewayProxyEventV2 =>
  ({
    version: "2.0",
    routeKey: "POST /{integration}",
    rawPath: `/${overrides.integration ?? ""}`,
    rawQueryString: "",
    headers: overrides.headers ?? {},
    requestContext: { requestId: overrides.requestId ?? "test-request-id" },
    pathParameters: overrides.integration === undefined ? undefined : { integration: overrides.integration },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false
  }) as unknown as APIGatewayProxyEventV2
