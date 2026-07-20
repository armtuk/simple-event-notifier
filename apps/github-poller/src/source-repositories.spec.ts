import { describe, expect, it } from "vitest"
import type { PollResult } from "./poll-result.ts"
import { eventsRepository, notificationsRepository, notificationsUrl } from "./source-repositories.ts"
import { fakeFetch, type ScriptedResponse, withFetch } from "./testing/poller-fixtures.ts"

const baseUrl = "https://api.github.com"
const signal = new AbortController().signal

const pollNotifications = async (script: readonly ScriptedResponse[], cursor = {}) => {
  const fake = fakeFetch(script)
  const result = await withFetch(fake, async () => notificationsRepository({ baseUrl, token: "classic-pat" }).poll(cursor, signal))
  return { result, fake }
}

const pollEvents = async (script: readonly ScriptedResponse[], cursor = {}) => {
  const fake = fakeFetch(script)
  const result = await withFetch(fake, async () =>
    eventsRepository({ baseUrl, token: "any-token", username: "alexrmturner" }).poll(cursor, signal)
  )
  return { result, fake }
}

const itemsOf = (result: PollResult): readonly unknown[] => (result.status === "items" ? result.items : [])

describe("the notifications repository", () => {
  it("polls the unread inbox", async () => {
    const { fake } = await pollNotifications([{ status: 200, body: [] }])
    expect(fake.requests[0]?.url).toBe("https://api.github.com/notifications?all=false")
  })

  it("carries the since cursor so the inbox is not re-scanned from the beginning", () => {
    expect(notificationsUrl(baseUrl, { since: "2026-07-19T19:02:11Z" })).toContain("since=2026-07-19")
  })

  it("sends If-Modified-Since once it has a Last-Modified — the mechanism that keeps 304s free", async () => {
    const { fake } = await pollNotifications([{ status: 304 }], { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT" })
    expect(fake.requests[0]?.headers["if-modified-since"]).toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })

  it("sends no conditional header on the first poll", async () => {
    const { fake } = await pollNotifications([{ status: 200, body: [] }])
    expect(fake.requests[0]?.headers["if-modified-since"]).toBeUndefined()
  })

  it("authenticates as a bearer token with the pinned API version", async () => {
    const { fake } = await pollNotifications([{ status: 200, body: [] }])
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer classic-pat")
    expect(fake.requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28")
  })

  it("returns the items and the new cursor on a 200", async () => {
    const { result } = await pollNotifications([
      { status: 200, headers: { "last-modified": "Sun, 19 Jul 2026 19:02:11 GMT" }, body: [{ id: "1" }] }
    ])
    expect(result.status).toBe("items")
    expect(itemsOf(result)).toStrictEqual([{ id: "1" }])
    expect(result.status === "items" ? result.cursor.lastModified : "").toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })

  it("reads a 304 as not-modified with no items", async () => {
    const { result } = await pollNotifications([{ status: 304 }])
    expect(result).toStrictEqual({ status: "not-modified" })
  })

  it("reads X-Poll-Interval from EVERY response, including a 304", async () => {
    const { result } = await pollNotifications([{ status: 304, headers: { "x-poll-interval": "120" } }])
    expect(result).toStrictEqual({ status: "not-modified", pollIntervalMs: 120_000 })
  })

  it("keeps a cursor a 200 response did not repeat, rather than clearing it and paying full price next poll", async () => {
    const { result } = await pollNotifications([{ status: 200, body: [] }], { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT" })
    expect(result.status === "items" ? result.cursor.lastModified : "").toBe("Sun, 19 Jul 2026 19:02:11 GMT")
  })

  it("reads a 429 as rate-limited, honouring Retry-After", async () => {
    const { result } = await pollNotifications([{ status: 429, headers: { "retry-after": "60" } }])
    expect(result).toMatchObject({ status: "rate-limited", retryAfterMs: 60_000 })
  })

  it("reads a 403 with no remaining budget as rate-limited, not as a permission failure", async () => {
    const { result } = await pollNotifications([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } }])
    expect(result.status).toBe("rate-limited")
  })

  it("reads a plain 403 WITH budget left as a failure — a permission problem must not be retried as throttling", async () => {
    const { result } = await pollNotifications([{ status: 403, headers: { "x-ratelimit-remaining": "4999" } }])
    expect(result.status).toBe("failure")
  })

  it("reads a 401 as a failure naming the status, which is what an invalid PAT produces", async () => {
    const { result } = await pollNotifications([{ status: 401 }])
    expect(result).toMatchObject({ status: "failure" })
    expect(result.status === "failure" ? result.message : "").toContain("401")
  })

  it("reads a 5xx as a failure rather than throwing", async () => {
    const { result } = await pollNotifications([{ status: 502 }])
    expect(result.status).toBe("failure")
  })

  it("reads a non-array 200 body as a failure rather than pretending it is a page", async () => {
    const { result } = await pollNotifications([{ status: 200, body: { message: "Bad credentials" } }])
    expect(result.status).toBe("failure")
  })

  it("turns a transport error into a failure, never a rejection", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => Promise.reject(new Error("ENOTFOUND api.github.com"))) as typeof globalThis.fetch
    const result = await notificationsRepository({ baseUrl, token: "t" }).poll({}, signal)
    globalThis.fetch = original
    expect(result).toStrictEqual({ status: "failure", message: "ENOTFOUND api.github.com" })
  })
})

describe("the events repository", () => {
  it("polls the authenticated user's received-events feed", async () => {
    const { fake } = await pollEvents([{ status: 200, body: [] }])
    expect(fake.requests[0]?.url).toBe("https://api.github.com/users/alexrmturner/received_events")
  })

  it("uses ETag / If-None-Match, its own conditional dialect", async () => {
    const { fake } = await pollEvents([{ status: 304 }], { etag: 'W/"abc123"' })
    expect(fake.requests[0]?.headers["if-none-match"]).toBe('W/"abc123"')
    expect(fake.requests[0]?.headers["if-modified-since"]).toBeUndefined()
  })

  it("captures the ETag from a 200 for the next poll", async () => {
    const { result } = await pollEvents([{ status: 200, headers: { etag: 'W/"def456"' }, body: [{ id: "1" }] }])
    expect(result.status === "items" ? result.cursor.etag : "").toBe('W/"def456"')
  })

  it("URL-encodes a username, so an odd login cannot alter the path", async () => {
    const fake = fakeFetch([{ status: 200, body: [] }])
    await withFetch(fake, async () => eventsRepository({ baseUrl, token: "t", username: "a/b" }).poll({}, signal))
    expect(fake.requests[0]?.url).toContain("/users/a%2Fb/received_events")
  })

  it("tolerates a base URL with a trailing slash", async () => {
    const fake = fakeFetch([{ status: 200, body: [] }])
    await withFetch(fake, async () => eventsRepository({ baseUrl: `${baseUrl}/`, token: "t", username: "u" }).poll({}, signal))
    expect(fake.requests[0]?.url).toBe("https://api.github.com/users/u/received_events")
  })
})
