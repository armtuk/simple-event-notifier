import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { matchKey, type Trigger, TriggerSchema } from "./channel.ts"

const decodeTrigger = Schema.decodeUnknownEither(TriggerSchema, { errors: "all" })

describe("TriggerSchema", () => {
  it("accepts a channel tag plus arbitrary string match-fields", () => {
    expect(decodeTrigger({ channel: "webhook", event: "pull_request", action: "opened" })).toStrictEqual(
      Either.right({ channel: "webhook", event: "pull_request", action: "opened" })
    )
  })

  it("accepts a bare channel with no match-fields", () => {
    expect(decodeTrigger({ channel: "notification" })).toStrictEqual(Either.right({ channel: "notification" }))
  })

  it("rejects a trigger with no channel, because the discriminant is what keeps namespaces apart", () => {
    expect(Either.isLeft(decodeTrigger({ event: "pull_request" }))).toBe(true)
  })

  it("rejects an empty channel", () => {
    expect(Either.isLeft(decodeTrigger({ channel: "" }))).toBe(true)
  })

  it("rejects a non-string match-field, so a numeric config value cannot silently stringify", () => {
    expect(Either.isLeft(decodeTrigger({ channel: "webhook", attempt: 3 }))).toBe(true)
  })
})

describe("matchKey", () => {
  it("is independent of field order, so a config rule and a runtime trigger cannot miss each other", () => {
    const authored: Trigger = { channel: "webhook", event: "pull_request", action: "opened" }
    const built: Trigger = { channel: "webhook", action: "opened", event: "pull_request" }
    expect(matchKey(authored)).toBe(matchKey(built))
  })

  it("renders the channel, then the sorted fields", () => {
    expect(matchKey({ channel: "webhook", event: "pull_request", action: "opened" })).toBe("webhook:action=opened&event=pull_request")
  })

  it("separates channels that share a match-field vocabulary", () => {
    expect(matchKey({ channel: "webhook", reason: "review_requested" })).not.toBe(
      matchKey({ channel: "notification", reason: "review_requested" })
    )
  })

  it("gives an action-less trigger a key a rule written without an action also produces", () => {
    expect(matchKey({ channel: "webhook", event: "push" })).toBe("webhook:event=push")
  })

  it("does NOT equate an absent field with an empty one", () => {
    expect(matchKey({ channel: "webhook", event: "push" })).not.toBe(matchKey({ channel: "webhook", event: "push", action: "" }))
  })

  it("keeps a channel with no fields distinguishable", () => {
    expect(matchKey({ channel: "notification" })).toBe("notification:")
  })

  it("escapes reserved characters so a field value cannot forge another rule's key (R1-10)", () => {
    // Without escaping, `action="opened&event=issues"` and the two-field trigger below both render
    // `webhook:action=opened&event=issues`, letting one trigger be classified by another's rule.
    expect(matchKey({ channel: "webhook", action: "opened&event=issues" })).not.toBe(
      matchKey({ channel: "webhook", action: "opened", event: "issues" })
    )
  })

  it("leaves GitHub's reserved-character-free values byte-for-byte unchanged", () => {
    expect(matchKey({ channel: "webhook", event: "pull_request", action: "review_requested" })).toBe(
      "webhook:action=review_requested&event=pull_request"
    )
  })
})
