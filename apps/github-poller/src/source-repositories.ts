import { conditionalGet } from "./github-http.ts"
import type { PollResult, SourceCursor } from "./poll-result.ts"

/**
 * One repository per GitHub source. Each owns exactly two things its sibling does not: the URL it
 * polls, and which conditional-request dialect that endpoint speaks. Everything else — headers,
 * status handling, cursor extraction — is the shared HTTP layer's.
 *
 * ## The credential constraint that shapes this whole story
 *
 * `GET /notifications` accepts a **classic** personal access token only. Fine-grained PATs and
 * GitHub App installation tokens are *not* supported on that endpoint — it is not a scope problem, a
 * fine-grained token simply cannot call it. The Events API accepts any token type. That asymmetry is
 * why the two sources hold separate tokens and are enabled independently.
 */

export interface GithubSourceRepository {
  readonly name: string
  readonly poll: (cursor: SourceCursor, signal: AbortSignal) => Promise<PollResult>
}

export const sourceNames = { notifications: "notifications", events: "events" } as const

export type SourceName = (typeof sourceNames)[keyof typeof sourceNames]

export interface NotificationsRepositoryOptions {
  readonly baseUrl: string
  /** A **classic** PAT with `notifications` or `repo` scope. Nothing else works on this endpoint. */
  readonly token: string
}

/**
 * The inbox uses `Last-Modified`/`If-Modified-Since`, and additionally a `since` cursor so a poll
 * does not re-scan the whole inbox from the beginning. `all=false` keeps it to unread items, which
 * is what a notification *is*.
 */
export const notificationsRepository = ({ baseUrl, token }: NotificationsRepositoryOptions): GithubSourceRepository => ({
  name: sourceNames.notifications,
  poll: async (cursor: SourceCursor, signal: AbortSignal): Promise<PollResult> =>
    conditionalGet({ url: notificationsUrl(baseUrl, cursor), token, cursor, conditional: "last-modified", signal })
})

export interface EventsRepositoryOptions {
  readonly baseUrl: string
  readonly token: string
  readonly username: string
}

/**
 * `received_events` is the authenticated user's own activity feed. It uses `ETag`/`If-None-Match`,
 * and carries hard limits worth remembering when reading the data: 30 s to 6 h of latency, and 30
 * days or 300 events of retention, whichever comes first. It is a *supplement* to the inbox, not a
 * complete history.
 */
export const eventsRepository = ({ baseUrl, token, username }: EventsRepositoryOptions): GithubSourceRepository => ({
  name: sourceNames.events,
  poll: async (cursor: SourceCursor, signal: AbortSignal): Promise<PollResult> =>
    conditionalGet({
      url: `${trimSlash(baseUrl)}/users/${encodeURIComponent(username)}/received_events`,
      token,
      cursor,
      conditional: "etag",
      signal
    })
})

export const notificationsUrl = (baseUrl: string, cursor: SourceCursor): string => {
  const url = new URL(`${trimSlash(baseUrl)}/notifications`)
  url.searchParams.set("all", "false")
  if (cursor.since !== undefined) {
    url.searchParams.set("since", cursor.since)
  }
  return url.toString()
}

const trimSlash = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")
