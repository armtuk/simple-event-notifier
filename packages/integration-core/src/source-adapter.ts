import type { Either } from "effect"
import type { NormalizedEvent } from "./normalized-event.ts"

/**
 * What every event source looks like once its provider specifics are behind it: something that
 * turns one raw delivery into zero or more `NormalizedEvent`s. A webhook body and a page of polled
 * inbox items both satisfy it — that shared shape is why the classification path is written once.
 *
 * It is deliberately **pure and synchronous**. An adapter decides *what an event is*, not *how it
 * arrives*: authentication, deduplication, rate limits and retries are the edge's job (AWE-156's
 * `WebhookIntegration`, AWE-157's poller cycles), and folding them in here would make the one
 * genuinely testable part of an integration require a network.
 *
 * `readonly NormalizedEvent[]` rather than a single event because a poll returns a page — and
 * because an ack-only delivery (GitHub's `ping`) is honestly expressed as the empty array.
 *
 * **No adapters are implemented in this package.** Concrete ones ship with their provider.
 */
export interface SourceAdapter<Raw = unknown, Failure = unknown> {
  readonly source: string
  readonly channel: string
  readonly toNormalizedEvents: (raw: Raw) => Either.Either<readonly NormalizedEvent[], Failure>
}
