/**
 * What one conditional poll of a GitHub source can produce. A closed, tagged set rather than an
 * exception surface, because every one of these is an **expected** outcome of a healthy poller:
 *
 * - `not-modified` — the ordinary steady state. GitHub does **not** charge a 304 against the
 *   rate-limit budget, which is why conditional requests are what make continuous polling viable.
 * - `rate-limited` — a 403/429 with `Retry-After` or a zero `X-RateLimit-Remaining`.
 * - `failure` — anything else. Reported, backed off, and retried; never fatal to the process.
 *
 * The cursor rides with `items` rather than being derived by the caller, because only the repository
 * knows which conditional-request mechanism its source speaks (`Last-Modified` vs `ETag`).
 */

export interface SourceCursor {
  readonly lastModified?: string
  readonly etag?: string
  /** The Notifications API's `since` parameter, so the inbox is not re-scanned from the beginning. */
  readonly since?: string
}

export interface PollItems {
  readonly status: "items"
  readonly items: readonly unknown[]
  readonly cursor: SourceCursor
  readonly pollIntervalMs?: number
}

export interface PollNotModified {
  readonly status: "not-modified"
  readonly pollIntervalMs?: number
}

export interface PollRateLimited {
  readonly status: "rate-limited"
  readonly retryAfterMs?: number
  readonly message: string
}

export interface PollFailure {
  readonly status: "failure"
  readonly message: string
}

export type PollResult = PollItems | PollNotModified | PollRateLimited | PollFailure
