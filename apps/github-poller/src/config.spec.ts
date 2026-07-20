import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { enabledSources, parsePollerConfig } from "./config.ts"

const complete = {
  EVENT_BUCKET_NAME: "events.prod.personal-events.fifthdimensionengineering.com",
  STATE_BUCKET_NAME: "state.prod.personal-events.fifthdimensionengineering.com",
  GITHUB_USERNAME: "alexrmturner",
  GITHUB_NOTIFICATIONS_PAT: "ghp_classic_token",
  GITHUB_EVENTS_PAT: "github_pat_fine_grained"
}

describe("parsePollerConfig", () => {
  it("reads a complete environment, defaulting the intervals and the state key", () => {
    expect(Either.getOrThrow(parsePollerConfig(complete))).toMatchObject({
      eventBucketName: complete.EVENT_BUCKET_NAME,
      stateBucketName: complete.STATE_BUCKET_NAME,
      stateKey: "state/github-poller.json",
      githubApiBaseUrl: "https://api.github.com",
      notificationsIntervalMs: 60_000,
      eventsIntervalMs: 300_000
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

  it("starts with NO token at all — a token is a per-source concern, not a startup gate", () => {
    const config = parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT: undefined, GITHUB_EVENTS_PAT: undefined })
    expect(Either.isRight(config)).toBe(true)
  })

  it("enables both sources when both tokens are present", () => {
    expect(enabledSources(Either.getOrThrow(parsePollerConfig(complete)))).toStrictEqual({ notifications: true, events: true })
  })

  it("enables only the source whose token is present, so one missing credential does not disable the other", () => {
    const notificationsOnly = Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_EVENTS_PAT: undefined }))
    expect(enabledSources(notificationsOnly)).toStrictEqual({ notifications: true, events: false })

    const eventsOnly = Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT: undefined }))
    expect(enabledSources(eventsOnly)).toStrictEqual({ notifications: false, events: true })
  })

  it("enables nothing when neither token is present", () => {
    const neither = Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT: undefined, GITHUB_EVENTS_PAT: undefined }))
    expect(enabledSources(neither)).toStrictEqual({ notifications: false, events: false })
  })

  it("treats an empty token as absent rather than sending an empty Authorization header", () => {
    expect(Either.isLeft(parsePollerConfig({ ...complete, GITHUB_NOTIFICATIONS_PAT: "" }))).toBe(true)
  })

  it("accepts overridden intervals and rejects nonsense ones", () => {
    expect(Either.getOrThrow(parsePollerConfig({ ...complete, NOTIFICATIONS_INTERVAL_MS: "90000" })).notificationsIntervalMs).toBe(90_000)
    expect(Either.isLeft(parsePollerConfig({ ...complete, NOTIFICATIONS_INTERVAL_MS: "0" }))).toBe(true)
    expect(Either.isLeft(parsePollerConfig({ ...complete, EVENTS_INTERVAL_MS: "soon" }))).toBe(true)
  })

  it("keeps the state key out of the event bucket by default", () => {
    const config = Either.getOrThrow(parsePollerConfig(complete))
    expect(config.stateBucketName).not.toBe(config.eventBucketName)
  })

  it.for([["local"], ["dev"], ["qa"], ["staging"], ["prod"]])("accepts the project environment %s", ([env]) => {
    expect(Either.getOrThrow(parsePollerConfig({ ...complete, ENV: env as string })).env).toBe(env)
  })

  it("refuses an environment outside the project's one vocabulary", () => {
    expect(Either.isLeft(parsePollerConfig({ ...complete, ENV: "stage" }))).toBe(true)
  })

  it("allows a base URL override, for GitHub Enterprise or a recorded fixture server", () => {
    expect(
      Either.getOrThrow(parsePollerConfig({ ...complete, GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3" })).githubApiBaseUrl
    ).toBe("https://ghe.example.com/api/v3")
  })
})
