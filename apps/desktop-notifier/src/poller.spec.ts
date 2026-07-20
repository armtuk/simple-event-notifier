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

/**
 * A **characterization** test of a known, deliberately-deferred limitation — it pins today's
 * behaviour so the gap is visible in the suite rather than only in prose, and so the follow-up fix
 * (a lookback poll plus a delivered-key set) turns these red and has to update them consciously.
 * See `feature.md` § Follow-up candidates.
 */
describe("advanceMark — the known loss window (documented, not desired)", () => {
  it("moves past a same-millisecond sibling that sorts lower, so a later write of it is unreachable", () => {
    const alert = "2026-01-01T00:00:00.000Z.alert.p5.github.x.json"
    const notification = "2026-01-01T00:00:00.000Z.notification.p8.github.x.json"
    // Within one instant the tie-break is eventType -> priority -> source -> name.
    expect(alert < notification).toBe(true)
    // A producer stamping one batch with a single toISOString() may PutObject the notification
    // first. A poll landing between the two writes takes the mark to the notification's key...
    const afterFirstWrite = advanceMark("", [notification])
    // ...and the alert, written second, now sorts below the mark, so StartAfter never returns it.
    expect(alert < afterFirstWrite).toBe(true)
    expect(advanceMark(afterFirstWrite, [alert])).toBe(afterFirstWrite)
  })

  it("moves past a skewed producer's key, so a slow clock writes below an already-set mark", () => {
    const fastProducer = "2026-01-01T00:00:02.000Z.alert.p5.github.x.json"
    const slowProducer = "2026-01-01T00:00:01.000Z.alert.p5.gitlab.y.json"
    expect(advanceMark(fastProducer, [slowProducer])).toBe(fastProducer)
    expect(slowProducer < fastProducer).toBe(true)
  })
})
