import { describe, expect, it } from "vitest"
import { eventsApiKey, notificationKey, partitionFresh } from "./dedupe.ts"

const item = (id: string, updatedAt?: string) => ({ id, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) })

describe("partitionFresh", () => {
  it("keeps only the items whose key is not already in the seen set", () => {
    const result = partitionFresh([item("a"), item("b"), item("c")], ["b"], value => (value as { id: string }).id, 100)
    expect(result.fresh.map(value => (value as { id: string }).id)).toStrictEqual(["a", "c"])
  })

  it("adds the fresh keys to the seen set, so a restart does not re-emit them", () => {
    const result = partitionFresh([item("a")], ["b"], value => (value as { id: string }).id, 100)
    expect(result.nextSeen).toStrictEqual(["a", "b"])
  })

  it("returns nothing fresh when everything has been seen — the steady state", () => {
    const result = partitionFresh([item("a"), item("b")], ["a", "b"], value => (value as { id: string }).id, 100)
    expect(result.fresh).toStrictEqual([])
    expect(result.nextSeen).toStrictEqual(["a", "b"])
  })

  it("caps the seen set, evicting the OLDEST — the newest keys must survive", () => {
    const result = partitionFresh([item("new")], ["old-1", "old-2"], value => (value as { id: string }).id, 2)
    expect(result.nextSeen).toStrictEqual(["new", "old-1"])
  })

  it("does not duplicate a key that appears twice in one page", () => {
    const result = partitionFresh([item("a"), item("a")], [], value => (value as { id: string }).id, 100)
    expect(result.nextSeen).toStrictEqual(["a"])
  })

  it("handles an empty page without touching the seen set", () => {
    expect(partitionFresh([], ["a"], () => "x", 100)).toStrictEqual({ fresh: [], nextSeen: ["a"] })
  })

  it("simulates a restart: state saved from cycle one suppresses the same items in cycle two", () => {
    const page = [item("a"), item("b")]
    const first = partitionFresh(page, [], value => (value as { id: string }).id, 100)
    const second = partitionFresh(page, first.nextSeen, value => (value as { id: string }).id, 100)
    expect(first.fresh).toHaveLength(2)
    expect(second.fresh).toHaveLength(0)
  })
})

describe("notificationKey", () => {
  it("is id AND updated_at, because GitHub reuses a thread id as the conversation continues", () => {
    expect(notificationKey(item("18442310771", "2026-07-19T19:02:11Z"))).toBe("18442310771:2026-07-19T19:02:11Z")
  })

  it("treats the same thread updated again as a NEW item — otherwise every reply is swallowed", () => {
    expect(notificationKey(item("1", "2026-07-19T19:02:11Z"))).not.toBe(notificationKey(item("1", "2026-07-19T19:30:00Z")))
  })

  it("degrades to a placeholder rather than throwing on a malformed item", () => {
    expect(notificationKey({})).toBe("unknown:unknown")
    expect(notificationKey("not an object")).toBe("unknown:unknown")
  })
})

describe("eventsApiKey", () => {
  it("is the item id alone, which is unique per activity event", () => {
    expect(eventsApiKey(item("56138220984"))).toBe("56138220984")
  })

  it("degrades to a placeholder rather than throwing", () => {
    expect(eventsApiKey({ id: 7 })).toBe("unknown")
  })
})
