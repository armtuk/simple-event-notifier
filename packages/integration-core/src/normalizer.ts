import type { Either } from "effect"
import type { NormalizedEvent } from "./normalized-event.ts"

/**
 * The one thing a new integration must supply to the template: a **normalizer** — a pure function
 * from a raw provider item to a `NormalizedEvent` (or a typed failure). Everything else the template
 * provides: `transform` classifies the result, `compileMappingConfig` / `loadMappingConfig` turn a
 * config into the lookup it needs, and `matchKey` keys it. So "adding an integration is a config + a
 * normalizer" is literally true — the normalizer is this type.
 *
 * It is a **function type, not an object interface**, on purpose. An earlier `SourceAdapter`
 * interface tried to be the seam and was implemented by nothing: both real edges (the webhook
 * `WebhookIntegration` and the poller's per-source `SourceDefinition`) compose free normalizer
 * *functions* — `@personal-events/github`'s `normalizeWebhook` / `normalizeNotification` /
 * `normalizeEventsApi` — rather than an object, because a normalizer has no state and no lifecycle.
 * The R1 review flagged the unused interface; this is the shape that matches how the template is
 * actually consumed, and it is what the Claude Code integration will implement next.
 */
export type Normalizer<Raw = unknown, Failure = unknown> = (raw: Raw) => Either.Either<NormalizedEvent, Failure>
