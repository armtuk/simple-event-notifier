import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EventTypeSchema, eventTypes, IsoInstant, NoDotString, Priority, priorityBounds, schemaVersions } from "./event.ts"

const accepts = <A, I>(schema: Schema.Schema<A, I>, input: unknown): boolean => Either.isRight(Schema.decodeUnknownEither(schema)(input))

describe("Priority", () => {
  it.each([priorityBounds.min, 4, priorityBounds.max])("accepts %i, inside the 1–8 attention range", value => {
    expect(accepts(Priority, value)).toBe(true)
  })

  it.each([0, 9, -1, 3.5, "5"])("rejects %o, which is not an integer in the 1–8 range", value => {
    expect(accepts(Priority, value)).toBe(false)
  })
})

describe("IsoInstant", () => {
  it.each(["2026-06-28T18:44:30.123Z", "2026-07-19T09:15:02Z", "2026-01-01T00:00:00.000000Z"])("accepts the UTC instant %s", value => {
    expect(accepts(IsoInstant, value)).toBe(true)
  })

  it.each(["2026-06-28T18:44:30+01:00", "2026-06-28 18:44:30Z", "28/06/2026", "2026-06-28T18:44:30"])(
    "rejects %s, which is not a UTC ISO-8601 instant",
    value => {
      expect(accepts(IsoInstant, value)).toBe(false)
    }
  )
})

describe("NoDotString", () => {
  it.each(["github", "new-pull-request", "claude_code", "a"])("accepts %s as an object-key segment", value => {
    expect(accepts(NoDotString, value)).toBe(true)
  })

  it.each(["", "github.com", "release.v1.2"])("rejects %o, which cannot survive the dotted object key", value => {
    expect(accepts(NoDotString, value)).toBe(false)
  })
})

describe("EventTypeSchema", () => {
  it.each(Object.values(eventTypes))("accepts the event type %s", value => {
    expect(accepts(EventTypeSchema, value)).toBe(true)
  })

  it("rejects an event type outside the alert/notification pair", () => {
    expect(accepts(EventTypeSchema, "warning")).toBe(false)
  })
})

describe("schemaVersions", () => {
  it("pins the current contract at version 1 so stored history stays interpretable", () => {
    expect(schemaVersions.v1).toBe(1)
  })
})
