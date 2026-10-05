import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda"

/**
 * The HTTP boundary, pure and separate from every decision that produced it. A response builder that
 * cannot fail and cannot log is trivially assertable, which matters because status codes are the one
 * thing a sender actually reacts to: GitHub treats any non-2xx as a failed delivery and does **not**
 * automatically retry it.
 *
 * Bodies stay minimal on purpose. This endpoint is internet-facing and unauthenticated up to the
 * signature check, so an error body must not describe internals to an anonymous caller.
 */

export const jsonContentType = "application/json"

export const ok = (body: Readonly<Record<string, unknown>>): APIGatewayProxyStructuredResultV2 => jsonResponse(200, body)

export const accepted = (body: Readonly<Record<string, unknown>>): APIGatewayProxyStructuredResultV2 => jsonResponse(202, body)

export const badRequest = (reason: string): APIGatewayProxyStructuredResultV2 => jsonResponse(400, { error: reason })

export const unauthorized = (): APIGatewayProxyStructuredResultV2 => jsonResponse(401, { error: "invalid signature" })

export const notFound = (): APIGatewayProxyStructuredResultV2 => jsonResponse(404, { error: "no such integration" })

export const serverError = (): APIGatewayProxyStructuredResultV2 => jsonResponse(500, { error: "internal error" })

const jsonResponse = (statusCode: number, body: Readonly<Record<string, unknown>>): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": jsonContentType },
  body: JSON.stringify(body)
})
