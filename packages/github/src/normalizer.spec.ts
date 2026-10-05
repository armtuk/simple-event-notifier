import { buildEventKey, parseKey } from "@personal-events/event-model"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { loadGithubConfig } from "./mapping.ts"
import { githubNotificationToEvent, githubToEvent, normalizeNotification, normalizeWebhook } from "./normalizer.ts"
import { readGithubExemplar } from "./testing/exemplars.ts"

const compiled = Either.getOrThrow(loadGithubConfig())
const toEventFromWebhook = githubToEvent(compiled)
const toEventFromNotification = githubNotificationToEvent(compiled)

const receivedAt = "2026-07-19T20:30:00.000Z"

const webhook = (eventName: string, fileName: string) => ({
  eventName,
  deliveryId: "5b1c8e40-84a1-11f1-9a3c-2b6f0e1d7c88",
  receivedAt,
  raw: readGithubExemplar(fileName)
})

describe("normalizeWebhook", () => {
  it("produces the canonical source, a dot-safe fallback name, and the injected instant", () => {
    const normalized = Either.getOrThrow(normalizeWebhook(webhook("pull_request", "webhook-pull_request-opened.json")))
    expect(normalized).toMatchObject({
      source: "github",
      name: "pull_request-opened",
      timestamp: receivedAt,
      trigger: { channel: "webhook", event: "pull_request", action: "opened" },
      workItem: "https://github.com/fifthdimensionengineering/aws-work-eventer/pull/42"
    })
  })

  it("sets producer to github-webhook and eventId to the delivery id, so distinct deliveries stay distinct and the delivery is dedupable", () => {
    const normalized = Either.getOrThrow(normalizeWebhook(webhook("pull_request", "webhook-pull_request-opened.json")))
    expect(normalized.producer).toBe("github-webhook")
    expect(normalized.eventId).toBe("5b1c8e40-84a1-11f1-9a3c-2b6f0e1d7c88")
  })

  it("carries the whole raw delivery through as payload, losing nothing the subset schema ignored", () => {
    const raw = readGithubExemplar("webhook-pull_request-opened.json")
    expect(Either.getOrThrow(normalizeWebhook(webhook("pull_request", "webhook-pull_request-opened.json"))).payload).toStrictEqual(raw)
  })

  it("omits the action from an action-less push, both in the name and in the trigger", () => {
    const normalized = Either.getOrThrow(normalizeWebhook(webhook("push", "webhook-push.json")))
    expect(normalized.name).toBe("push")
    expect(normalized.trigger).toStrictEqual({ channel: "webhook", event: "push" })
  })

  it("normalizes an unmodelled event through the generic reader rather than failing", () => {
    const normalized = Either.getOrThrow(normalizeWebhook(webhook("deployment_status", "webhook-unmodelled-deployment_status.json")))
    expect(normalized.name).toBe("deployment_status-created")
    expect(normalized).not.toHaveProperty("workItem")
  })

  it("fails typed, naming the delivery and the event, when the payload is malformed", () => {
    const failure = Either.getOrThrow(
      Either.flip(normalizeWebhook(webhook("pull_request", "invalid-webhook-pull_request-missing-html-url.json")))
    )
    expect(failure._tag).toBe("GithubNormalizeError")
    expect(failure).toMatchObject({ channel: "webhook", itemId: "5b1c8e40-84a1-11f1-9a3c-2b6f0e1d7c88", descriptor: "pull_request" })
    expect(failure.reason).toContain("html_url")
  })

  it("fails typed when the edge injects an instant it cannot parse", () => {
    const failure = Either.getOrThrow(Either.flip(normalizeWebhook({ ...webhook("push", "webhook-push.json"), receivedAt: "not a time" })))
    expect(failure.reason).toContain("not a time")
  })
})

describe("normalizeNotification", () => {
  it("sets producer to github-poller and eventId to the notification id", () => {
    const normalized = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-review_requested.json")))
    expect(normalized.producer).toBe("github-poller")
    expect(normalized.eventId).toBe("18442310771")
  })

  it("takes its instant from updated_at, widened to the contract's three fractional digits", () => {
    const normalized = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-review_requested.json")))
    expect(normalized).toMatchObject({
      source: "github",
      name: "review_requested",
      timestamp: "2026-07-19T19:02:11.000Z",
      trigger: { channel: "notification", reason: "review_requested" },
      workItem: "https://api.github.com/repos/fifthdimensionengineering/aws-work-eventer/pulls/42"
    })
  })

  it("omits workItem when the subject has no addressable url", () => {
    const normalized = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-security_alert-null-subject-url.json")))
    expect(normalized).not.toHaveProperty("workItem")
  })

  it("fails typed, naming the notification id, when the item is malformed", () => {
    const failure = Either.getOrThrow(Either.flip(normalizeNotification(readGithubExemplar("invalid-notification-missing-subject.json"))))
    expect(failure).toMatchObject({ channel: "notification", itemId: "18442312001" })
  })

  it("fails typed on an unparseable updated_at rather than substituting the current time", () => {
    const failure = Either.getOrThrow(
      Either.flip(normalizeNotification(readGithubExemplar("invalid-notification-unparseable-updated-at.json")))
    )
    expect(failure).toMatchObject({ itemId: "18442312444", descriptor: "mention" })
    expect(failure.reason).toContain("yesterday afternoon")
  })

  it("reports an unidentifiable item as such rather than throwing", () => {
    expect(Either.getOrThrow(Either.flip(normalizeNotification({}))).itemId).toBe("unknown")
  })

  /**
   * The recorded hazard, pinned as a characterization: two inbox items GitHub updated in the same
   * second become two events whose keys differ only after the timestamp. This asserts today's
   * behaviour, not the desired one — the fix awaits a delivery-semantics decision.
   */
  it("gives two same-second notifications the identical timestamp, so their keys sort adjacently", () => {
    const first = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-review_requested.json")))
    const second = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-mention.json")))
    expect(first.timestamp).toBe("2026-07-19T19:02:11.000Z")
    expect(second.timestamp).toBe("2026-07-19T19:02:11.000Z")
    expect(first.timestamp).toBe(second.timestamp)
  })

  /**
   * The *ordering* hazard, pinned end-to-end: two distinct inbox items with the same `reason` in the
   * same second normalise to an identical `timestamp`, `trigger` and `name`, so their object keys
   * differ **only** in `eventId` and sort adjacently. The `eventId` now keeps the two objects from
   * colliding (R1-2 fixed), but the adjacency is still what makes a consumer's bare high-water mark
   * able to skip a sibling — the separate lookback-window follow-up. Breaks loudly the day someone
   * changes the precision handling.
   */
  it("gives two distinct same-reason, same-second items an identical timestamp, trigger and name — differing only in eventId", () => {
    const base = readGithubExemplar("notification-mention.json") as Record<string, unknown>
    const first = Either.getOrThrow(normalizeNotification(base))
    const second = Either.getOrThrow(normalizeNotification({ ...base, id: "18442310999" }))
    expect(first.timestamp).toBe(second.timestamp)
    expect(first.trigger).toStrictEqual(second.trigger)
    expect(first.name).toBe(second.name)
    expect(first.eventId).not.toBe(second.eventId)
  })
})

describe("githubToEvent / githubNotificationToEvent — the whole path an edge calls", () => {
  it.for([
    ["pull_request", "webhook-pull_request-opened.json", "notification", 5, "new-pull-request"],
    ["pull_request", "webhook-pull_request-review_requested.json", "alert", 4, "review-requested"],
    ["pull_request_review", "webhook-pull_request_review-submitted.json", "alert", 5, "pull-request-review-submitted"],
    ["issues", "webhook-issues-opened.json", "notification", 5, "new-issue"],
    ["push", "webhook-push.json", "notification", 7, "push"],
    ["release", "webhook-release-published.json", "notification", 5, "new-release"]
  ])("classifies a %s delivery to %s → %s p%d %s", ([eventName, fileName, eventType, priority, name]) => {
    const event = Either.getOrThrow(toEventFromWebhook(webhook(eventName as string, fileName as string)))
    expect(event).toMatchObject({ eventType, priority, name, source: "github" })
  })

  it.for([
    ["notification-review_requested.json", "alert", 4, "review-requested"],
    ["notification-mention.json", "alert", 4, "mention"],
    ["notification-security_alert-null-subject-url.json", "alert", 2, "security-alert"]
  ])("classifies %s to %s p%d %s", ([fileName, eventType, priority, name]) => {
    const event = Either.getOrThrow(toEventFromNotification(readGithubExemplar(fileName as string)))
    expect(event).toMatchObject({ eventType, priority, name })
  })

  it("classifies an unmapped webhook event to the config default, and writes it rather than dropping it", () => {
    const event = Either.getOrThrow(toEventFromWebhook(webhook("deployment_status", "webhook-unmodelled-deployment_status.json")))
    expect(event).toMatchObject({ eventType: "notification", priority: 3, name: "deployment_status-created" })
  })

  it("classifies an unmapped notification reason to the config default", () => {
    const event = Either.getOrThrow(toEventFromNotification(readGithubExemplar("notification-unmapped-subscribed.json")))
    expect(event).toMatchObject({ eventType: "notification", priority: 3, name: "subscribed" })
  })

  it("produces an object key that round-trips through the codec", () => {
    const event = Either.getOrThrow(toEventFromWebhook(webhook("pull_request", "webhook-pull_request-opened.json")))
    const key = buildEventKey(event)
    expect(key).toBe(
      "2026-07-19T20:30:00.000Z.notification.p5.github.new-pull-request.github-webhook.5b1c8e40-84a1-11f1-9a3c-2b6f0e1d7c88.json"
    )
    expect(Either.isRight(parseKey(key))).toBe(true)
  })

  it("never lets a dotted repository name reach a key segment", () => {
    const event = Either.getOrThrow(toEventFromNotification(readGithubExemplar("notification-mention.json")))
    expect(event.source).not.toContain(".")
    expect(event.name).not.toContain(".")
  })

  it("propagates a normalize failure without attempting to classify it", () => {
    const failure = Either.getOrThrow(Either.flip(toEventFromWebhook(webhook("issues", "invalid-webhook-issues-number-as-string.json"))))
    expect(failure._tag).toBe("GithubNormalizeError")
  })
})
