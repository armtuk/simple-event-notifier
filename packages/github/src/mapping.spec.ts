import { classify, loadMappingConfig, matchKey } from "@personal-events/integration-core"
import { Either } from "effect"
import { describe, expect, it } from "vitest"
import { buildNotificationTrigger, buildWebhookTrigger } from "./github-trigger.ts"
import { githubMappingConfig, loadGithubConfig, loadGithubConfigFrom } from "./mapping.ts"
import { validateGithubTriggers } from "./mapping-validation.ts"
import { normalizeNotification, normalizeWebhook } from "./normalizer.ts"
import { readGithubExemplar } from "./testing/exemplars.ts"

const compiled = Either.getOrThrow(loadGithubConfig())

describe("the bundled GitHub mapping config", () => {
  it("is schema-valid and compiles", () => {
    expect(compiled.integration).toBe("github")
    expect(compiled.ruleCount).toBeGreaterThan(0)
  })

  it("has no duplicate trigger keys — every authored rule survives compilation", () => {
    expect(compiled.lookup.size).toBe(compiled.ruleCount)
  })

  it("declares no secondary processors, because none are implemented this feature", () => {
    expect(Either.isRight(loadGithubConfig([]))).toBe(true)
  })

  it("covers every resolved webhook event and action", () => {
    const covered = [
      ["pull_request", "opened"],
      ["pull_request", "closed"],
      ["pull_request", "ready_for_review"],
      ["pull_request", "review_requested"],
      ["pull_request_review", "submitted"],
      ["issues", "opened"],
      ["issues", "closed"],
      ["issues", "assigned"],
      ["release", "published"]
    ] as const
    expect(covered.filter(([event, action]) => !classify(compiled, buildWebhookTrigger(event, action)).matched)).toStrictEqual([])
    expect(classify(compiled, buildWebhookTrigger("push", undefined)).matched).toBe(true)
  })

  it("covers every resolved notification reason", () => {
    const reasons = ["review_requested", "mention", "team_mention", "assign", "ci_activity", "security_alert"]
    expect(reasons.filter(reason => !classify(compiled, buildNotificationTrigger(reason)).matched)).toStrictEqual([])
  })

  it("matches a mention rule for every subject type, because the trigger carries only the reason", () => {
    expect(classify(compiled, buildNotificationTrigger("mention")).matched).toBe(true)
  })

  it("gives the same trigger the same key whether it came from the JSON or from a normalizer", () => {
    const fromNormalizer = Either.getOrThrow(
      normalizeWebhook({
        eventName: "pull_request",
        deliveryId: "d",
        receivedAt: "2026-07-19T20:30:00.000Z",
        raw: readGithubExemplar("webhook-pull_request-opened.json")
      })
    ).trigger
    expect(compiled.lookup.has(matchKey(fromNormalizer))).toBe(true)
  })

  it("gives a normalized notification a key present in the compiled config", () => {
    const fromNormalizer = Either.getOrThrow(normalizeNotification(readGithubExemplar("notification-mention.json"))).trigger
    expect(compiled.lookup.has(matchKey(fromNormalizer))).toBe(true)
  })

  it("keeps the same word in two channels as two separate rules", () => {
    expect(classify(compiled, buildWebhookTrigger("pull_request", "review_requested")).output).toStrictEqual(
      classify(compiled, buildNotificationTrigger("review_requested")).output
    )
    expect(classify(compiled, buildWebhookTrigger("review_requested", undefined)).matched).toBe(false)
  })

  it("classifies a security alert as the highest-priority thing it emits", () => {
    const priorities = [...compiled.lookup.values()].map(output => output.priority)
    expect(classify(compiled, buildNotificationTrigger("security_alert")).output.priority).toBe(Math.min(...priorities))
  })

  it("falls back to a low-priority notification rather than an alert, so an unknown event cannot cry wolf", () => {
    expect(compiled.fallback).toStrictEqual({ eventType: "notification", priority: 3 })
  })

  it("rejects an edited config that names a processor nobody registered", () => {
    const edited = {
      ...(githubMappingConfig as Record<string, unknown>),
      default: { eventType: "notification", priority: 3, secondaryProcessing: ["enrich-from-api"] }
    }
    const failure = Either.getOrThrow(Either.flip(loadMappingConfig(edited, { knownProcessors: [] })))
    expect(failure._tag).toBe("UnknownProcessorError")
  })

  it("rejects an edited config whose priority leaves the contract's range — the JSON is untrusted input too", () => {
    const edited = { ...(githubMappingConfig as Record<string, unknown>), default: { eventType: "alert", priority: 0 } }
    expect(Either.getOrThrow(Either.flip(loadMappingConfig(edited, { knownProcessors: [] })))._tag).toBe("ConfigParseError")
  })
})

describe("validateGithubTriggers — the gate the framework's open trigger schema cannot provide", () => {
  const withTrigger = (trigger: unknown): unknown => ({
    integration: "github",
    rules: [{ trigger, output: { eventType: "notification", priority: 4, name: "x" } }],
    default: { eventType: "notification", priority: 3 }
  })

  it("accepts the bundled config", () => {
    expect(Either.isRight(validateGithubTriggers(githubMappingConfig))).toBe(true)
  })

  it("rejects a misspelt channel, which the framework's open schema would accept and never match", () => {
    const failure = Either.getOrThrow(Either.flip(loadGithubConfigFrom(withTrigger({ channel: "webook", event: "push" }))))
    expect(failure._tag).toBe("GithubConfigError")
    expect(failure._tag === "GithubConfigError" ? failure.offendingTriggers : []).toStrictEqual(['{"channel":"webook","event":"push"}'])
  })

  it("rejects a webhook rule wearing a notification's vocabulary", () => {
    expect(Either.getOrThrow(Either.flip(loadGithubConfigFrom(withTrigger({ channel: "webhook", reason: "review_requested" }))))._tag).toBe(
      "GithubConfigError"
    )
  })

  it("rejects a notification rule carrying a field no channel defines, rather than silently stripping it", () => {
    expect(
      Either.getOrThrow(
        Either.flip(loadGithubConfigFrom(withTrigger({ channel: "notification", reason: "mention", subjectType: "Issue" })))
      )._tag
    ).toBe("GithubConfigError")
  })

  it("names every offending trigger at once, so a config is fixed in one pass", () => {
    const config = {
      integration: "github",
      rules: [
        { trigger: { channel: "webook", event: "push" }, output: { eventType: "notification", priority: 4 } },
        { trigger: { channel: "notification" }, output: { eventType: "notification", priority: 4 } }
      ],
      default: { eventType: "notification", priority: 3 }
    }
    const failure = Either.getOrThrow(Either.flip(loadGithubConfigFrom(config)))
    expect(failure._tag).toBe("GithubConfigError")
    expect(failure._tag === "GithubConfigError" ? failure.offendingTriggers : []).toHaveLength(2)
  })

  it("still defers shape failures the framework owns to the framework", () => {
    const config = { integration: "github", rules: [], default: { eventType: "alert", priority: 99 } }
    expect(Either.getOrThrow(Either.flip(loadGithubConfigFrom(config)))._tag).toBe("ConfigParseError")
  })
})
