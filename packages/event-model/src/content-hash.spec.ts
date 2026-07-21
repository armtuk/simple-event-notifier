import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { contentHashId } from "./content-hash.ts"
import { NoDotString } from "./event.ts"

const isNoDot = (value: string): boolean => Either.isRight(Schema.decodeUnknownEither(NoDotString)(value))

describe("contentHashId", () => {
  it("is deterministic — the same content yields the same id", () => {
    expect(contentHashId({ a: 1, b: [2, 3] })).toBe(contentHashId({ a: 1, b: [2, 3] }))
  })

  it("differs when the content differs, so distinct events get distinct ids", () => {
    expect(contentHashId({ id: "a" })).not.toBe(contentHashId({ id: "b" }))
  })

  it("produces a dot-free string the key codec accepts as a segment", () => {
    const id = contentHashId({ payload: { title: "Ünïcödé — has spaces. and dots." }, source: "github" })
    expect(id).not.toContain(".")
    expect(isNoDot(id)).toBe(true)
  })

  it("is 16 hex characters — 64 bits, ample against accidental collision and short enough to read", () => {
    expect(contentHashId("anything")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("distinguishes objects whose key order differs at the top level, as JSON.stringify does", () => {
    expect(contentHashId({ a: 1, b: 2 })).not.toBe(contentHashId({ b: 2, a: 1 }))
  })
})
