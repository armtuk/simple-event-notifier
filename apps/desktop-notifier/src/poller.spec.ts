import { describe, expect, it } from "vitest"
import { advanceMark } from "./poller.ts"

/**
 * `pollOnce`, `listKeysAfter` and `fetchObjectBody` are exercised against a real bucket by
 * `poller.integration.spec.ts`, which needs credentials and a disposable bucket. `advanceMark` is
 * the pure part and is the piece that decides whether an event is ever re-delivered, so it is
 * pinned here.
 */

const mark = "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json"

const later = "2026-06-28T18:44:31.000Z.alert.p5.github.new-pull-request.json"

const evenLater = "2026-06-28T18:44:32.000Z.notification.p8.claude-code.prompt-complete.json"

describe("advanceMark", () => {
  it("holds the mark when a poll returns nothing", () => {
    expect(advanceMark(mark, [])).toBe(mark)
  })

  it("advances to the highest key seen", () => {
    expect(advanceMark(mark, [later, evenLater])).toBe(evenLater)
  })

  it("advances past a key that failed to parse, so one bad object is not retried forever", () => {
    expect(advanceMark(mark, ["2026-06-28T18:44:31.000Z.garbage.json"])).toBe("2026-06-28T18:44:31.000Z.garbage.json")
  })

  it("never moves backwards, whatever order the keys arrive in", () => {
    expect(advanceMark(evenLater, [later, mark])).toBe(evenLater)
  })

  it("distinguishes two events written in the same millisecond by their full key", () => {
    const a = "2026-06-28T18:44:30.123Z.alert.p5.github.a.json"
    const b = "2026-06-28T18:44:30.123Z.alert.p5.github.b.json"
    expect(advanceMark("", [a, b])).toBe(b)
    expect(a < b).toBe(true)
  })
})
