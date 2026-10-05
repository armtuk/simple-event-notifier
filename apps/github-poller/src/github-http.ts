import { describeCause } from "@personal-events/event-model"
import type { PollResult, SourceCursor } from "./poll-result.ts"

/**
 * One authenticated conditional GET against the GitHub REST API, reduced to a `PollResult`.
 *
 * **Conditional requests are not an optimisation here, they are the mechanism.** The core rate limit
 * is 5000 requests/hour, and a `304 Not Modified` is explicitly **not** charged against it — so a
 * poller that sends `If-Modified-Since`/`If-None-Match` can run continuously, and one that does not
 * will exhaust its budget and start failing. The two sources speak different dialects of the same
 * idea (`Last-Modified` for Notifications, `ETag` for Events), so both are supported.
 *
 * `X-Poll-Interval` is read from **every** response including a 304, and honoured as a floor on the
 * next delay. GitHub raises it under load; ignoring it is how a client gets blocked.
 *
 * Global `fetch` is used rather than an HTTP client dependency: Node 24 has it, and this module is
 * the "centralized HTTP channel layer" `.agents/guidance/api-integrations.md` asks for — one place
 * to instrument, one place where a rate-limit reservation would later be injected.
 */

export interface ConditionalGetOptions {
  readonly url: string
  readonly token: string
  readonly cursor: SourceCursor
  readonly conditional: "last-modified" | "etag"
  readonly signal: AbortSignal
}

export const githubApiVersion = "2022-11-28"

export const githubAcceptHeader = "application/vnd.github+json"

export const conditionalGet = async ({ url, token, cursor, conditional, signal }: ConditionalGetOptions): Promise<PollResult> =>
  fetch(url, { headers: requestHeaders(token, cursor, conditional), signal })
    .then(async response => toPollResult(response, cursor))
    .catch((cause: unknown): PollResult => ({ status: "failure", message: describeCause(cause) }))

const requestHeaders = (
  token: string,
  cursor: SourceCursor,
  conditional: ConditionalGetOptions["conditional"]
): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: githubAcceptHeader,
  "x-github-api-version": githubApiVersion,
  "user-agent": "personal-events-github-poller",
  ...conditionalHeader(cursor, conditional)
})

const conditionalHeader = (cursor: SourceCursor, conditional: ConditionalGetOptions["conditional"]): Record<string, string> => {
  const value = conditional === "etag" ? cursor.etag : cursor.lastModified
  return value === undefined ? {} : { [conditional === "etag" ? "if-none-match" : "if-modified-since"]: value }
}

const toPollResult = async (response: Response, cursor: SourceCursor): Promise<PollResult> => {
  const pollIntervalMs = pollIntervalOf(response)
  if (response.status === 304) {
    return { status: "not-modified", ...optionalNumber("pollIntervalMs", pollIntervalMs) }
  }
  if (isRateLimited(response)) {
    return { status: "rate-limited", message: rateLimitMessage(response), ...optionalNumber("retryAfterMs", retryAfterOf(response)) }
  }
  if (!response.ok) {
    return { status: "failure", message: `GitHub answered HTTP ${response.status} ${response.statusText} for ${response.url}` }
  }
  return readItems(response, cursor, pollIntervalMs)
}

const readItems = async (response: Response, cursor: SourceCursor, pollIntervalMs: number | undefined): Promise<PollResult> =>
  response
    .json()
    .then(
      (body: unknown): PollResult =>
        Array.isArray(body)
          ? { status: "items", items: body, cursor: nextCursor(response, cursor), ...optionalNumber("pollIntervalMs", pollIntervalMs) }
          : { status: "failure", message: `expected a JSON array from ${response.url} but got ${typeof body}` }
    )
    .catch((cause: unknown): PollResult => ({ status: "failure", message: `could not read the response body: ${describeCause(cause)}` }))

/**
 * The cursor is only ever *widened* from a successful response. A source that answers 200 without
 * the header it usually sends must not clear a cursor it previously had, or the very next poll
 * re-fetches the whole page unconditionally and pays full rate-limit price for it.
 */
const nextCursor = (response: Response, cursor: SourceCursor): SourceCursor => ({
  ...optionalString("lastModified", response.headers.get("last-modified") ?? cursor.lastModified),
  ...optionalString("etag", response.headers.get("etag") ?? cursor.etag),
  ...optionalString("since", cursor.since)
})

/**
 * GitHub signals a rate limit as **403 or 429**, distinguished from an ordinary auth failure by
 * `x-ratelimit-remaining: 0` or the presence of `retry-after`. A plain 403 with budget left is a
 * genuine permission problem and must not be retried as if it were throttling.
 */
const isRateLimited = (response: Response): boolean =>
  response.status === 429 ||
  (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))

const rateLimitMessage = (response: Response): string =>
  `GitHub rate-limited ${response.url}: HTTP ${response.status}, remaining=${response.headers.get("x-ratelimit-remaining") ?? "?"}, reset=${response.headers.get("x-ratelimit-reset") ?? "?"}`

const retryAfterOf = (response: Response): number | undefined => {
  const retryAfter = secondsHeader(response, "retry-after")
  const reset = secondsHeader(response, "x-ratelimit-reset")
  return retryAfter !== undefined ? retryAfter * 1000 : reset === undefined ? undefined : Math.max(0, reset * 1000 - Date.now())
}

const pollIntervalOf = (response: Response): number | undefined => {
  const seconds = secondsHeader(response, "x-poll-interval")
  return seconds === undefined ? undefined : seconds * 1000
}

const secondsHeader = (response: Response, name: string): number | undefined => {
  const raw = response.headers.get(name)
  const parsed = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `exactOptionalPropertyTypes` again: an explicitly-undefined key is not the same as an absent one. */
const optionalNumber = <K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, number>)

const optionalString = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, string>)
