import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { configuredSources, parsePollerConfig } from "./config.ts"

const complete = {
  EVENT_BUCKET_NAME: "events.prod.personal-events.fifthdimensionengineering.com",
  STATE_BUCKET_NAME: "state.prod.personal-events.fifthdimensionengineering.com",
  GITHUB_USERNAME: "alexrmturner",
  GITHUB_NOTIFICATIONS_PAT_PARAM: "/personal-events/github/notifications-pat",
  GITHUB_EVENTS_PAT_PARAM: "/personal-events/github/events-pat"
}

describe("parsePollerConfig", () => {
  it("reads a complete environment, defaulting the state key and API base", () => {
    expect(Either.getOrThrow(parsePollerConfig(complete))).toMatchObject({
      eventBucketName: complete.EVENT_BUCKET_NAME,
      stateBucketName: complete.STATE_BUCKET_NAME,
      stateKey: "state/github-poller.json",
      githubApiBaseUrl: "https://api.github.com",
      seenCap: 1_000
    })
  })

  it("refuses to start without an event bucket or a state bucket", () => {
    const failure = Either.getOrThrow(Either.flip(parsePollerConfig({ GITHUB_USERNAME: "x" })))
    expect(failure).toContain("eventBucketName")
    expect(failure).toContain("stateBucketName")
  })

  it("refuses to start without a username, which the Events API URL is built from", () => {
    expect(Either.isLeft(parsePollerConfig({ ...complete, GITHUB_USERNAME: undefined }))).toBe(true)
  })

  it("starts with NO token parameter — a source is a per-source concern, not a startup gate", () => {
    expect(
      Either.isRight(parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT_PARAM: undefined, GITHUB_EVENTS_PAT_PARAM: undefined }))
    ).toBe(true)
  })

  it("configures both sources when both parameter names are present", () => {
    expect(configuredSources(Either.getOrThrow(parsePollerConfig(complete)))).toStrictEqual({ notifications: true, events: true })
  })

  it("configures only the source whose parameter is present, so one missing credential does not disable the other", () => {
    const notificationsOnly = Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_EVENTS_PAT_PARAM: undefined }))
    expect(configuredSources(notificationsOnly)).toStrictEqual({ notifications: true, events: false })

    const eventsOnly = Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT_PARAM: undefined }))
    expect(configuredSources(eventsOnly)).toStrictEqual({ notifications: false, events: true })
  })

  it("configures nothing when neither parameter is present", () => {
    const neither = Either.getOrThrow(
      parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT_PARAM: undefined, GITHUB_EVENTS_PAT_PARAM: undefined })
    )
    expect(configuredSources(neither)).toStrictEqual({ notifications: false, events: false })
  })

  it("keeps the state key out of the event bucket by default", () => {
    const config = Either.getOrThrow(parsePollerConfig(complete))
    expect(config.stateBucketName).not.toBe(config.eventBucketName)
  })

  it("rejects a non-positive fetch timeout", () => {
    expect(Either.isLeft(parsePollerConfig({ ...complete, FETCH_TIMEOUT_MS: "0" }))).toBe(true)
    expect(Either.getOrThrow(parsePollerConfig({ ...complete, FETCH_TIMEOUT_MS: "5000" })).fetchTimeoutMs).toBe(5000)
  })

  it("allows a base URL override, for GitHub Enterprise or a recorded fixture server", () => {
    expect(
      Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3" })).githubApiBaseUrl
    ).toBe("https://ghe.example.com/api/v3")
  })
})
