import { matchKey, type Trigger, TriggerSchema } from "@personal-events/integration-core"
import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildEventsApiTrigger,
  buildNotificationTrigger,
  buildWebhookTrigger,
  GithubTriggerSchema,
  githubChannels
} from "./github-trigger.ts"

const decodeGithubTrigger = Schema.decodeUnknownEither(GithubTriggerSchema, { errors: "all" })
const decodeOpenTrigger = Schema.decodeUnknownEither(TriggerSchema, { errors: "all" })

describe("GithubTriggerSchema", () => {
  it("accepts each of the three channels", () => {
    expect(Either.isRight(decodeGithubTrigger({ channel: "webhook", event: "push" }))).toBe(true)
    expect(Either.isRight(decodeGithubTrigger({ channel: "notification", reason: "mention" }))).toBe(true)
    expect(Either.isRight(decodeGithubTrigger({ channel: "events_api", type: "PushEvent" }))).toBe(true)
  })

  it("rejects a channel GitHub does not speak, so a typo in a config rule fails at load", () => {
    expect(Either.isLeft(decodeGithubTrigger({ channel: "webook", event: "push" }))).toBe(true)
  })

  it("refuses a webhook trigger wearing a notification's field — this is the non-confusability the union exists for", () => {
    expect(Either.isLeft(decodeGithubTrigger({ channel: "webhook", reason: "review_requested" }))).toBe(true)
  })

  it("refuses a notification trigger wearing a webhook's fields", () => {
    expect(Either.isLeft(decodeGithubTrigger({ channel: "notification", event: "pull_request", action: "review_requested" }))).toBe(true)
  })

  it("ignores an excess field by default, which is why config validation decodes with onExcessProperty: error", () => {
    expect(Either.isRight(decodeGithubTrigger({ channel: "notification", reason: "mention", subjectType: "Issue" }))).toBe(true)
  })
})

describe("the trigger builders", () => {
  it("omit an absent action entirely, so a push matches a rule written without one", () => {
    expect(buildWebhookTrigger("push", undefined)).toStrictEqual({ channel: "webhook", event: "push" })
    expect(matchKey(buildWebhookTrigger("push", undefined))).toBe("webhook:event=push")
  })

  it("include an action when there is one", () => {
    expect(matchKey(buildWebhookTrigger("pull_request", "opened"))).toBe("webhook:action=opened&event=pull_request")
  })

  it("carry only the reason, the one field a notification rule discriminates on", () => {
    expect(buildNotificationTrigger("mention")).toStrictEqual({ channel: "notification", reason: "mention" })
  })

  it("build events_api triggers for the source AWE-157 finalizes", () => {
    expect(buildEventsApiTrigger("PullRequestEvent", "review_requested")).toStrictEqual({
      channel: "events_api",
      type: "PullRequestEvent",
      action: "review_requested"
    })
  })

  it.for([
    [buildWebhookTrigger("pull_request", "opened")],
    [buildWebhookTrigger("push", undefined)],
    [buildNotificationTrigger("review_requested")],
    [buildEventsApiTrigger("PushEvent", undefined)]
  ])("produce a value the framework's open Trigger schema accepts: %o", ([trigger]) => {
    expect(Either.isRight(decodeOpenTrigger(trigger as Trigger))).toBe(true)
  })

  it.for([
    [buildWebhookTrigger("pull_request", "opened")],
    [buildNotificationTrigger("review_requested")],
    [buildEventsApiTrigger("PullRequestEvent", "review_requested")]
  ])("produce a value the GitHub union also accepts, so builders and config rules agree: %o", ([trigger]) => {
    expect(Either.isRight(decodeGithubTrigger(trigger as Trigger))).toBe(true)
  })

  it("keeps the same underlying vocabulary distinguishable across channels", () => {
    expect(matchKey(buildNotificationTrigger("review_requested"))).not.toBe(matchKey(buildWebhookTrigger("review_requested", undefined)))
  })

  it("names the channels once, as values rather than an enum", () => {
    expect(Object.values(githubChannels)).toStrictEqual(["webhook", "notification", "events_api"])
  })
})
