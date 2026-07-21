import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { readGithubExemplar } from "./testing/exemplars.ts"
import { GenericWebhookSchema } from "./webhook-payloads.ts"
import { isModelledWebhookEvent, readerFor } from "./webhook-schema-registry.ts"

/**
 * Alignment against GitHub's own OpenAPI-generated definitions is asserted at **compile time**, in
 * `octokit-alignment.ts` — a type claim wants a type check, and `tsc --noEmit` over that module is
 * the assertion. What runs here is the behavioural half: real captured payloads through the readers.
 */

const decodeGeneric = Schema.decodeUnknownEither(GenericWebhookSchema, { errors: "all" })

describe("the subset schemas over captured payloads", () => {
  it.for([
    ["pull_request", "webhook-pull_request-opened.json"],
    ["pull_request", "webhook-pull_request-review_requested.json"],
    ["pull_request_review", "webhook-pull_request_review-submitted.json"],
    ["issues", "webhook-issues-opened.json"],
    ["push", "webhook-push.json"],
    ["release", "webhook-release-published.json"]
  ])("reads a %s delivery from %s", ([eventName, fileName]) => {
    const facts = readerFor(eventName as string).read(readGithubExemplar(fileName as string))
    expect(Either.isRight(facts)).toBe(true)
    expect(Either.getOrThrow(facts).repository).toBe("fifthdimensionengineering/aws-work-eventer")
  })

  it("extracts the pull request's html_url as the work item", () => {
    const facts = Either.getOrThrow(readerFor("pull_request").read(readGithubExemplar("webhook-pull_request-opened.json")))
    expect(facts).toStrictEqual({
      action: "opened",
      workItem: "https://github.com/fifthdimensionengineering/aws-work-eventer/pull/42",
      repository: "fifthdimensionengineering/aws-work-eventer"
    })
  })

  it("extracts the reviewed pull request, not the review, as a review event's work item", () => {
    const facts = Either.getOrThrow(readerFor("pull_request_review").read(readGithubExemplar("webhook-pull_request_review-submitted.json")))
    expect(facts.workItem).toBe("https://github.com/fifthdimensionengineering/aws-work-eventer/pull/42")
  })

  it("reports a push as action-less, which is what lets its trigger match an action-less rule", () => {
    const facts = Either.getOrThrow(readerFor("push").read(readGithubExemplar("webhook-push.json")))
    expect(facts.action).toBeUndefined()
    expect(facts.workItem).toContain("/compare/")
  })

  it.for([
    ["invalid-webhook-pull_request-missing-html-url.json", "pull_request"],
    ["invalid-webhook-issues-number-as-string.json", "issues"]
  ])("rejects %s rather than emitting an event with a missing or mistyped field", ([fileName, eventName]) => {
    expect(Either.isLeft(readerFor(eventName as string).read(readGithubExemplar(fileName as string)))).toBe(true)
  })

  it("ignores fields GitHub adds that we do not model, so a new upstream field is not an outage", () => {
    const withNewField = { ...(readGithubExemplar("webhook-push.json") as Record<string, unknown>), some_future_field: { a: 1 } }
    expect(Either.isRight(readerFor("push").read(withNewField))).toBe(true)
  })
})

describe("the generic fallback schema", () => {
  it("accepts an event we have not modelled, so it can still be classified and written", () => {
    const facts = Either.getOrThrow(readerFor("deployment_status").read(readGithubExemplar("webhook-unmodelled-deployment_status.json")))
    expect(facts).toStrictEqual({ action: "created", workItem: undefined, repository: "fifthdimensionengineering/aws-work-eventer" })
  })

  it("accepts a ping, which carries no action at all", () => {
    expect(Either.isRight(readerFor("ping").read(readGithubExemplar("webhook-ping.json")))).toBe(true)
  })

  it("still refuses a body that is not an object", () => {
    expect(Either.isLeft(decodeGeneric("not a payload"))).toBe(true)
    expect(Either.isLeft(decodeGeneric(null))).toBe(true)
  })

  it("still refuses a non-string action, which is a malformed delivery rather than an unfamiliar one", () => {
    expect(Either.isLeft(decodeGeneric({ action: 7 }))).toBe(true)
  })

  it("knows which events are modelled and which fall through", () => {
    expect(isModelledWebhookEvent("pull_request")).toBe(true)
    expect(isModelledWebhookEvent("deployment_status")).toBe(false)
    expect(isModelledWebhookEvent("ping")).toBe(false)
  })
})
