import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EventTypeSchema, eventTypes, IsoInstant, NoDotString, Priority, priorityBounds, schemaVersions, WorkItemUrl } from "./event.ts"

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
  it.each(["2026-06-28T18:44:30.123Z", "2026-07-19T09:15:02.000Z", "2026-01-01T00:00:00.000Z"])("accepts the UTC instant %s", value => {
    expect(accepts(IsoInstant, value)).toBe(true)
  })

  it.each(["2026-06-28T18:44:30+01:00", "2026-06-28 18:44:30Z", "28/06/2026", "2026-06-28T18:44:30"])(
    "rejects %s, which is not a UTC ISO-8601 instant",
    value => {
      expect(accepts(IsoInstant, value)).toBe(false)
    }
  )

  it.each(["2026-07-19T09:15:02Z", "2026-06-28T18:44:30.12Z", "2026-01-01T00:00:00.000000Z"])(
    "rejects %s, whose fraction is not exactly three digits and would break key ordering",
    value => {
      expect(accepts(IsoInstant, value)).toBe(false)
    }
  )

  it("accepts exactly what Date.toISOString emits, which is what seeds the daemon's high-water mark", () => {
    expect(accepts(IsoInstant, new Date("2026-07-19T09:15:02.400Z").toISOString())).toBe(true)
  })
})

/**
 * The invariant the whole system rests on. The object key leads with the instant, and consumers use
 * "the last key I processed" as a high-water mark against `ListObjectsV2 StartAfter`, which is
 * exclusive and lexicographic. If lexicographic order ever diverges from chronological order, an
 * earlier event sorts after a later one and is skipped permanently.
 */
describe("IsoInstant ordering", () => {
  const chronological = [
    "2026-06-28T18:44:30.000Z",
    "2026-06-28T18:44:30.001Z",
    "2026-06-28T18:44:30.120Z",
    "2026-06-28T18:44:30.123Z",
    "2026-06-28T18:44:30.500Z",
    "2026-06-28T18:44:31.000Z",
    "2026-06-28T18:45:00.000Z",
    "2026-07-19T09:15:02.000Z",
    "2027-01-01T00:00:00.000Z"
  ]

  it("orders every accepted instant identically by string and by time", () => {
    expect(chronological.toSorted()).toStrictEqual(chronological)
    expect(chronological.toSorted((a, b) => Date.parse(a) - Date.parse(b))).toStrictEqual(chronological)
  })

  it("accepts every instant in the ordering table", () => {
    expect(chronological.filter(value => !accepts(IsoInstant, value))).toStrictEqual([])
  })

  it("gives every accepted instant the same width, which is what makes the two orders agree", () => {
    expect(new Set(chronological.map(value => value.length)).size).toBe(1)
  })

  it("rejects the mixed-precision forms that would invert the ordering", () => {
    // Documents the hazard: '.' (0x2E) sorts below every digit and 'Z' (0x5A) above every digit,
    // so these compare backwards. They must never reach a key.
    expect("2026-06-28T18:44:30Z" > "2026-06-28T18:44:30.500Z").toBe(true)
    expect("2026-06-28T18:44:30.12Z" > "2026-06-28T18:44:30.123Z").toBe(true)
    expect(accepts(IsoInstant, "2026-06-28T18:44:30Z")).toBe(false)
    expect(accepts(IsoInstant, "2026-06-28T18:44:30.12Z")).toBe(false)
  })
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

describe("WorkItemUrl", () => {
  it.each(["https://www.jira.com/browse/AWE-150", "https://github.com", "HTTPS://GitHub.com/Foo"])("accepts %s", value => {
    expect(accepts(WorkItemUrl, value)).toBe(true)
  })

  it.each(["not a url", "", "/relative/path"])("rejects %o, which is not an absolute URL", value => {
    expect(accepts(WorkItemUrl, value)).toBe(false)
  })

  it("stores the producer's exact bytes rather than a normalized URL", () => {
    const decode = Schema.decodeUnknownEither(WorkItemUrl)
    const encode = Schema.encodeEither(WorkItemUrl)
    const nonNormalized = ["https://github.com", "HTTPS://GitHub.com/Foo", "https://x.test/a?b=1&b=2"]
    expect(nonNormalized.map(value => Either.getOrThrow(Either.flatMap(decode(value), encode)))).toStrictEqual(nonNormalized)
  })

  it("would have been rewritten by a URL-instance codec, which is why this one is a string", () => {
    expect(new URL("https://github.com").toString()).not.toBe("https://github.com")
    expect(new URL("HTTPS://GitHub.com/Foo").toString()).not.toBe("HTTPS://GitHub.com/Foo")
  })
})

describe("schemaVersions", () => {
  it("pins the current contract at version 1 so stored history stays interpretable", () => {
    expect(schemaVersions.v1).toBe(1)
  })
})
