import type { APIGatewayProxyEventV2 } from "aws-lambda"

/**
 * Gather: the API Gateway v2 event reduced to the three things an integration needs.
 *
 * **The raw body is security-critical.** GitHub's `X-Hub-Signature-256` is an HMAC over the exact
 * bytes it sent, so the body must reach the verifier untouched — never parsed and re-stringified,
 * which would reorder keys, drop insignificant whitespace, and silently invalidate every signature.
 * The only transformation applied is the base64 decode API Gateway's own `isBase64Encoded` flag
 * demands, and that is byte-exact.
 *
 * Header names are lower-cased because HTTP header names are case-insensitive and API Gateway's
 * normalization is not something to depend on: an integration looking up `x-hub-signature-256` must
 * not miss a delivery because the sender capitalised it.
 */

export interface RawRequest {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly rawBody: string
}

export const integrationPathParameter = "integration"

export const parseRawRequest = (event: APIGatewayProxyEventV2): RawRequest => ({
  path: event.pathParameters?.[integrationPathParameter] ?? "",
  headers: lowerCaseHeaders(event.headers),
  rawBody: decodeBody(event.body, event.isBase64Encoded)
})

const decodeBody = (body: string | undefined, isBase64Encoded: boolean): string =>
  body === undefined ? "" : isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body

const lowerCaseHeaders = (headers: APIGatewayProxyEventV2["headers"]): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name.toLowerCase(), value as string])
  )
