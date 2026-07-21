import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { decodeNotification } from "./notification.ts"
import { readGithubExemplar } from "./testing/exemplars.ts"

describe("NotificationSchema over captured inbox items", () => {
  it.for([
    ["notification-review_requested.json"],
    ["notification-mention.json"],
    ["notification-security_alert-null-subject-url.json"],
    ["notification-unmapped-subscribed.json"]
  ])("accepts %s", ([fileName]) => {
    expect(Either.isRight(decodeNotification(readGithubExemplar(fileName as string)))).toBe(true)
  })

  it("reads exactly the fields the normalizer needs", () => {
    const notification = Either.getOrThrow(decodeNotification(readGithubExemplar("notification-review_requested.json")))
    expect(notification).toStrictEqual({
      id: "18442310771",
      reason: "review_requested",
      updated_at: "2026-07-19T19:02:11Z",
      subject: {
        title: "AWE-154: GitHub payload schemas, mapping config & normalizer",
        type: "PullRequest",
        url: "https://api.github.com/repos/fifthdimensionengineering/aws-work-eventer/pulls/42"
      },
      repository: { full_name: "fifthdimensionengineering/aws-work-eventer" }
    })
  })

  it("accepts a null subject url — a Dependabot alert has no addressable resource, and it is the item we most want", () => {
    const notification = Either.getOrThrow(decodeNotification(readGithubExemplar("notification-security_alert-null-subject-url.json")))
    expect(notification.subject.url).toBeNull()
    expect(notification.subject.type).toBe("RepositoryVulnerabilityAlert")
  })

  it("rejects an item with no subject at all", () => {
    expect(Either.isLeft(decodeNotification(readGithubExemplar("invalid-notification-missing-subject.json")))).toBe(true)
  })

  it("accepts an id that is a string, as the API sends it, and refuses a numeric one", () => {
    expect(Either.isLeft(decodeNotification({ ...(readGithubExemplar("notification-mention.json") as object), id: 18442310988 }))).toBe(
      true
    )
  })

  it("refuses a body that is not an object", () => {
    expect(Either.isLeft(decodeNotification("not a notification"))).toBe(true)
  })
})
