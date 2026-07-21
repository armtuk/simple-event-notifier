import { isoInstantPattern } from "@personal-events/event-model"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { toCanonicalInstant } from "./instant.ts"

describe("toCanonicalInstant", () => {
  it("widens the Notifications API's second-precision timestamp to the contract's three digits", () => {
    expect(toCanonicalInstant("2026-07-19T19:02:11Z")).toStrictEqual(Either.right("2026-07-19T19:02:11.000Z"))
  })

  it("preserves millisecond detail when GitHub actually sends it", () => {
    expect(toCanonicalInstant("2026-07-19T19:02:11.457Z")).toStrictEqual(Either.right("2026-07-19T19:02:11.457Z"))
  })

  it("converts an offset timestamp to UTC, because the object key sorts on the rendered string", () => {
    expect(toCanonicalInstant("2026-07-19T19:14:52+01:00")).toStrictEqual(Either.right("2026-07-19T18:14:52.000Z"))
  })

  it("truncates sub-millisecond precision rather than rounding the key into a different instant", () => {
    expect(toCanonicalInstant("2026-07-19T19:02:11.4571234Z")).toStrictEqual(Either.right("2026-07-19T19:02:11.457Z"))
  })

  it.for([["2026-07-19T19:02:11Z"], ["2026-07-19T19:02:11.457Z"], ["2026-07-19T19:14:52+01:00"]])(
    "always produces a value matching the contract's instant pattern for %s",
    ([input]) => {
      expect(isoInstantPattern.test(Either.getOrThrow(toCanonicalInstant(input as string)))).toBe(true)
    }
  )

  it("fails typed on an unparseable value, naming the offending input", () => {
    const failure = Either.getOrThrow(Either.flip(toCanonicalInstant("yesterday afternoon")))
    expect(failure).toContain("yesterday afternoon")
    expect(failure).toContain("not a parseable timestamp")
  })

  it("fails on an empty string rather than defaulting to the epoch or to now", () => {
    expect(Either.isLeft(toCanonicalInstant(""))).toBe(true)
  })

  /**
   * The hazard this module documents, pinned as a characterization: two notifications GitHub
   * updated in the same second are indistinguishable by timestamp once normalised. This asserts the
   * behaviour as it *is*, not as it should be — the fix awaits a product decision on delivery
   * semantics. See the module docblock and the feature plan.
   */
  it("erases the distinction between a bare second and an explicit .000, which is where the collapse begins", () => {
    expect(toCanonicalInstant("2026-07-19T19:02:11Z")).toStrictEqual(toCanonicalInstant("2026-07-19T19:02:11.000Z"))
  })

  it("maps every sub-millisecond instant within one second onto the SAME canonical instant", () => {
    const withinOneSecond = ["2026-07-19T19:02:11Z", "2026-07-19T19:02:11.000Z", "2026-07-19T19:02:11.0001Z", "2026-07-19T19:02:11.0009Z"]
    expect(new Set(withinOneSecond.map(value => Either.getOrThrow(toCanonicalInstant(value)))).size).toBe(1)
  })

  it("still separates instants a millisecond apart, so the collapse is precision loss and not a constant", () => {
    expect(Either.getOrThrow(toCanonicalInstant("2026-07-19T19:02:11.001Z"))).not.toBe(
      Either.getOrThrow(toCanonicalInstant("2026-07-19T19:02:11.002Z"))
    )
  })
})
