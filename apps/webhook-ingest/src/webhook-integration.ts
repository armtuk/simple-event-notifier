import type { RawRequest } from "./raw-request.ts"

/**
 * What the ingest registry holds. Deliberately **not** `integration-core`'s `SourceAdapter`: that
 * interface is pure and synchronous by design, and a webhook edge is neither. It must authenticate
 * (an HMAC over the raw body), deduplicate (a delivery id already seen), acknowledge without writing
 * (GitHub's `ping`), and persist — all asynchronous, all provider-specific in their dependencies.
 *
 * So a concrete integration composes the pure `SourceAdapter`/normalizer **inside** `handle`, and
 * owns its own collaborators (injected when it is registered). The handler stays a router plus an
 * outcome→HTTP mapping, and `integration-core` stays free of anything a webhook implies.
 *
 * `WebhookOutcome` is a closed set because the handler's response mapping is a `Record` over it —
 * adding a case without deciding its status code is then a compile error rather than a 500.
 */

export interface WebhookEventsAccepted {
  readonly status: "events"
  readonly count: number
}

/** Understood and deliberately not written: a `ping`, or a delivery already seen. */
export interface WebhookAcknowledged {
  readonly status: "ack"
  readonly reason: string
}

export interface WebhookUnauthorized {
  readonly status: "unauthorized"
}

export interface WebhookBadRequest {
  readonly status: "bad-request"
  readonly reason: string
}

export interface WebhookServerError {
  readonly status: "server-error"
}

export type WebhookOutcome = WebhookEventsAccepted | WebhookAcknowledged | WebhookUnauthorized | WebhookBadRequest | WebhookServerError

export interface WebhookIntegration {
  readonly source: string
  readonly handle: (request: RawRequest) => Promise<WebhookOutcome>
}
