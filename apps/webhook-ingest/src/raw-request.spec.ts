import { describe, expect, it } from "vitest"
import { parseRawRequest } from "./raw-request.ts"
import { proxyEvent } from "./testing/stub-integration.ts"

const signedBody = '{"action":"opened","number":42}'

describe("parseRawRequest", () => {
  it("reads the integration from the path parameter API Gateway's wildcard route supplies", () => {
    expect(parseRawRequest(proxyEvent({ integration: "github" })).path).toBe("github")
  })

  it("reports an empty path when the route matched without one, rather than guessing", () => {
    expect(parseRawRequest(proxyEvent({})).path).toBe("")
  })

  it("passes a plain body through byte-for-byte, because the HMAC is over exactly these bytes", () => {
    expect(parseRawRequest(proxyEvent({ body: signedBody })).rawBody).toBe(signedBody)
  })

  it("base64-decodes only when API Gateway says it encoded the body", () => {
    const encoded = Buffer.from(signedBody, "utf8").toString("base64")
    expect(parseRawRequest(proxyEvent({ body: encoded, isBase64Encoded: true })).rawBody).toBe(signedBody)
  })

  it("does not decode a body that merely looks like base64 when the flag is false", () => {
    const looksEncoded = "eyJhIjoxfQ=="
    expect(parseRawRequest(proxyEvent({ body: looksEncoded })).rawBody).toBe(looksEncoded)
  })

  it("preserves whitespace and key order, which a parse-then-restringify would silently destroy", () => {
    const spaced = '{\n  "action": "opened",\n  "number": 42\n}'
    expect(parseRawRequest(proxyEvent({ body: spaced })).rawBody).toBe(spaced)
  })

  it("survives a UTF-8 multi-byte body through the base64 path", () => {
    const body = '{"title":"Ünïcödé — ✅"}'
    const encoded = Buffer.from(body, "utf8").toString("base64")
    expect(parseRawRequest(proxyEvent({ body: encoded, isBase64Encoded: true })).rawBody).toBe(body)
  })

  it("reports a missing body as an empty string rather than undefined", () => {
    expect(parseRawRequest(proxyEvent({})).rawBody).toBe("")
  })

  it("lower-cases header names, so a differently-cased signature header is still found", () => {
    const headers = { "X-Hub-Signature-256": "sha256=abc", "X-GitHub-Event": "push" }
    expect(parseRawRequest(proxyEvent({ headers })).headers).toStrictEqual({
      "x-hub-signature-256": "sha256=abc",
      "x-github-event": "push"
    })
  })

  it("drops headers with no value rather than surfacing undefined to an integration", () => {
    expect(parseRawRequest(proxyEvent({ headers: { "x-github-event": undefined } })).headers).toStrictEqual({})
  })
})
