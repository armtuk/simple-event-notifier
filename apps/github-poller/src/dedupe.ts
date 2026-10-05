/**
 * Which items in a page have not been seen before, and what the seen-set becomes as a result. Pure,
 * so "does a restart re-notify?" is a question a unit spec can settle rather than an integration
 * test.
 *
 * The set is **bounded and most-recent-first**. An unbounded set would grow forever inside a JSON
 * object that is read and written every cycle; capping it means the poller can, in principle,
 * re-emit an item it saw more than `cap` items ago. That is the right trade for this system: the cap
 * is far larger than any real page, and a duplicate event is a visible annoyance where an
 * ever-growing state object is an eventual outage.
 *
 * Fresh keys go **before** the retained ones so the cap evicts the oldest, which is the only
 * ordering under which the trade above holds.
 */

export interface FreshPartition<T> {
  readonly fresh: readonly T[]
  readonly nextSeen: readonly string[]
}

export const partitionFresh = <T>(
  items: readonly T[],
  seen: readonly string[],
  keyOf: (item: T) => string,
  cap: number
): FreshPartition<T> => {
  const seenSet = new Set(seen)
  const fresh = items.filter(item => !seenSet.has(keyOf(item)))
  return { fresh, nextSeen: [...new Set([...fresh.map(keyOf), ...seen])].slice(0, cap) }
}

/**
 * A notification's identity is `id` **plus** `updated_at`: GitHub reuses the thread id as the
 * conversation continues, so keying on `id` alone would deliver the first comment on a thread and
 * silently swallow every one after it.
 */
export const notificationKey = (item: unknown): string => `${stringField(item, "id")}:${stringField(item, "updated_at")}`

/** An activity item's `id` is unique per event, so it needs no compound key. */
export const eventsApiKey = (item: unknown): string => stringField(item, "id")

/**
 * A key is only ever used for set membership, so an unreadable field degrades to `"unknown"` rather
 * than throwing. Such an item is about to fail normalization and be skipped anyway; what must not
 * happen is one malformed item taking down the cycle around it.
 */
const stringField = (item: unknown, field: string): string =>
  typeof item === "object" && item !== null && field in item && typeof (item as Record<string, unknown>)[field] === "string"
    ? String((item as Record<string, unknown>)[field])
    : "unknown"
