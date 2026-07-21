import { NoDotString } from "@personal-events/event-model"
import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toDotSafe } from "./dot-safe.ts"

const decodeSegment = Schema.decodeUnknownEither(NoDotString)

describe("toDotSafe", () => {
  it("replaces the object key's structural delimiter", () => {
    expect(toDotSafe("github.com")).toBe("github-com")
  })

  it("collapses a run of dots into one replacement", () => {
    expect(toDotSafe("a...b")).toBe("a-b")
  })

  it("folds whitespace, which is legal in S3 but miserable in a URL or a log line", () => {
    expect(toDotSafe("ready for review")).toBe("ready-for-review")
  })

  it("trims rather than leaving a leading or trailing replacement", () => {
    expect(toDotSafe("  push  ")).toBe("push")
  })

  it("leaves an already-safe value untouched", () => {
    expect(toDotSafe("pull_request-opened")).toBe("pull_request-opened")
  })

  it.for([["github.com"], ["a...b"], ["ready for review"], ["  push  "], ["pull_request-opened"], ["v1.2.3"]])(
    "produces a value the event contract accepts as a key segment for %s",
    ([input]) => {
      expect(Either.isRight(decodeSegment(toDotSafe(input as string)))).toBe(true)
    }
  )
})
