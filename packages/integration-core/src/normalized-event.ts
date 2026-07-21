import { IsoInstant, NoDotString } from "@personal-events/event-model"
import { Schema } from "effect"
import { TriggerSchema } from "./channel.ts"

/**
 * The seam between a provider package and the framework. A normalizer — the only code that knows a
 * provider's wire shapes — reduces a raw payload to this, and `transform` classifies it. That split
 * is what keeps `integration-core` free of every provider specific while still owning **all**
 * classification: the framework never inspects a GitHub field, and the GitHub package never decides
 * whether something is an alert.
 *
 * `payload` carries the **untouched** raw provider object. The subset a normalizer validates is for
 * extraction and safety; nothing is stripped, because the stored event is permanent history and a
 * field discarded here is a field no future consumer can recover.
 */

export const NormalizedEventSchema = /*#__PURE__*/ Schema.Struct({
  source: NoDotString,
  name: NoDotString,
  timestamp: IsoInstant,
  /**
   * The logical origin (`event.producer`) and the per-item id (`event.eventId`) the normalizer must
   * supply, because only it knows a provider's delivery/event id. They are what make the object key
   * identify an event — see `@personal-events/event-model` § "One object key denotes one event".
   */
  producer: NoDotString,
  eventId: NoDotString,
  trigger: TriggerSchema,
  workItem: Schema.optionalWith(Schema.String, { exact: true }),
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown })
}).annotations({ identifier: "NormalizedEvent" })

export type NormalizedEvent = typeof NormalizedEventSchema.Type
