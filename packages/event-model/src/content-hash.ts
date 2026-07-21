import { createHash } from "node:crypto"

/**
 * A stable, dot-free id derived from a value's content, for the `eventId` of a producer that has no
 * provider-supplied delivery id of its own (a local agent, a cron job). Where a provider *does* give
 * an id — `X-GitHub-Delivery`, a notification id — that id is used instead. For a
 * **content-timestamped** producer (the poller / local agents, whose `timestamp` comes from the item)
 * a provider id makes a real re-delivery idempotent; for the **webhook** path, whose `timestamp` is a
 * wall-clock instant re-read per delivery, `X-GitHub-Delivery` cannot — its redelivery builds a
 * different key, so its `X-GitHub-Delivery` dedupe store is the guarantee. A content hash only makes
 * *identical bytes* idempotent, which is weaker but still correct.
 *
 * It is the first 16 hex characters of a SHA-256 over the canonical JSON of the value. Sixteen hex
 * digits is 64 bits — ample against accidental collision for a personal event stream, and short
 * enough to keep the object key readable. It is deterministic (same value → same id) and contains no
 * `.`, so it satisfies the key's no-dot constraint without further normalisation.
 *
 * Hash the event body **without** its `eventId` (the field this computes), or the computation is
 * circular. Callers pass the identifying content — typically the raw provider payload plus the
 * canonical `source`/`name`/`timestamp` — not the whole event.
 */
export const contentHashId = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
