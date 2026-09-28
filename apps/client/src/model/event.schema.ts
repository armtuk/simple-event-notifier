import {Schema} from "effect"

export const eventTypeSchema = Schema.Literals(["alert", "info"])

export const eventSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  timestamp: Schema.Date,
  eventType: eventTypeSchema,
  priority: Schema.Number,
  source: Schema.String,
  workItem: Schema.Option(Schema.URL),
  name: Schema.String,
  payload : Schema.Any
})

export type Event = typeof eventSchema.Type