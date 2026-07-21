import type { Event } from "@personal-events/event-model"

/**
 * A named side-effect a mapping rule can ask for by name (`output.secondaryProcessing`) — enrich a
 * payload, open a ticket, page someone. **The interface only**: no processors are implemented this
 * feature, and nothing executes one yet.
 *
 * The name-indirection is the point. A rule names a hook as a string, the host declares which names
 * it can run, and `loadMappingConfig` refuses a config that asks for one nobody registered. That
 * keeps the config decoupled from the host's capabilities while making a mismatch loud at start-up
 * instead of silent at runtime.
 *
 * The execution model — inline before the S3 write, or enqueued after it — is **undecided** and is
 * a later feature. It matters enough to defer: running inline puts an arbitrary third party inside
 * a GitHub delivery's ~10 s budget, and running after the write means a failed processor cannot
 * un-write the event. Fixing the interface now without fixing the model keeps that choice open.
 */
export interface SecondaryProcessor {
  readonly name: string
  readonly process: (event: Event) => Promise<void>
}
