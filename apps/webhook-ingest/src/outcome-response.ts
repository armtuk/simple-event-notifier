import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda"
import { accepted, badRequest, ok, serverError, unauthorized } from "./response.ts"
import type { WebhookOutcome } from "./webhook-integration.ts"

/**
 * Outcome → HTTP, as a total `Record` over the outcome tags. Exhaustiveness is the point: a new
 * outcome without a status code becomes a compile error instead of an unhandled case that 500s in
 * production.
 *
 * Two of the codes are deliberate rather than obvious:
 *
 * - **`events` is 202, not 200.** The write has happened by the time this runs, but "accepted" is
 *   the honest word for an ingest endpoint, and it keeps the door open for the accept-then-write
 *   variant if a delivery ever risks GitHub's ~10 s budget.
 * - **A persist failure is 5xx, not a silent 2xx.** GitHub will not retry it, so the 5xx is not a
 *   retry request — it is what makes the failure visible in GitHub's own delivery log, where an
 *   operator can redeliver by hand. The poller is the automatic backstop.
 */

type OutcomeResponder = (outcome: WebhookOutcome) => APIGatewayProxyStructuredResultV2

const respondToEvents: OutcomeResponder = outcome => accepted({ accepted: outcome.status === "events" ? outcome.count : 0 })

const respondToAck: OutcomeResponder = outcome => ok({ acknowledged: outcome.status === "ack" ? outcome.reason : "" })

const respondToUnauthorized: OutcomeResponder = () => unauthorized()

const respondToBadRequest: OutcomeResponder = outcome => badRequest(outcome.status === "bad-request" ? outcome.reason : "bad request")

const respondToServerError: OutcomeResponder = () => serverError()

const responders: Record<WebhookOutcome["status"], OutcomeResponder> = {
  events: respondToEvents,
  ack: respondToAck,
  unauthorized: respondToUnauthorized,
  "bad-request": respondToBadRequest,
  "server-error": respondToServerError
}

export const outcomeToResponse = (outcome: WebhookOutcome): APIGatewayProxyStructuredResultV2 => responders[outcome.status](outcome)
