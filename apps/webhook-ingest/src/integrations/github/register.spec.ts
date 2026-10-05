import type { S3Client } from "@aws-sdk/client-s3"
import { S3EventRepository } from "@personal-events/event-sink"
import { describe, expect, it } from "vitest"
import type { IngestConfig } from "../../config.ts"
import { capturingLogger, entriesFor } from "../../testing/stub-integration.ts"
import { GithubWebhookIntegration } from "./github-integration.ts"
import { githubRegistrationDefaults, registerGithub } from "./register.ts"
import { eventBucket, stateBucket } from "./testing/github-fixtures.ts"

const registration = {
  region: "us-east-1",
  secretParameterName: githubRegistrationDefaults.secretParameterName,
  stateBucketName: stateBucket,
  deliveryPrefix: githubRegistrationDefaults.deliveryPrefix
}

const depsWith = () => {
  const log = capturingLogger()
  return {
    log,
    deps: {
      events: new S3EventRepository({ send: async () => ({}) } as unknown as S3Client, eventBucket),
      logger: log.logger,
      config: {} as IngestConfig
    }
  }
}

describe("registerGithub", () => {
  it("registers exactly one integration, under the canonical source name", () => {
    const { deps } = depsWith()
    const integrations = registerGithub(registration)(deps)
    expect(integrations).toHaveLength(1)
    expect(integrations[0]?.source).toBe("github")
  })

  it("logs what it registered, including where the secret and the markers live", () => {
    const { deps, log } = depsWith()
    registerGithub(registration)(deps)
    expect(entriesFor(log.captured, "github integration registered")[0]).toMatchObject({
      secretParameter: githubRegistrationDefaults.secretParameterName,
      deliveryPrefix: `${stateBucket}/${githubRegistrationDefaults.deliveryPrefix}`
    })
  })

  it("reports the rule count, so a config that shrank unexpectedly is visible at start-up", () => {
    const { deps, log } = depsWith()
    registerGithub(registration)(deps)
    expect(Number(entriesFor(log.captured, "github integration registered")[0]?.rules)).toBeGreaterThan(10)
  })

  it("defaults the secret parameter to the path Terraform creates", () => {
    expect(githubRegistrationDefaults.secretParameterName).toBe("/personal-events/github/webhook-secret")
  })

  it("injects the shared event repository rather than constructing its own", () => {
    const { deps } = depsWith()
    const [integration] = registerGithub(registration)(deps)
    expect(integration instanceof GithubWebhookIntegration && integration.deps.events).toBe(deps.events)
  })

  /**
   * The two-bucket rule, guarded **where the wiring decision is actually made**. The earlier version
   * of this guard asserted `new DeliveryDedupeRepository(…, stateBucket, …).bucket === stateBucket`
   * — that a constructor stores its argument — and would have passed unchanged if `register.ts`
   * started passing the event bucket, which is the exact regression the whole edifice exists to
   * prevent.
   *
   * Belt and braces: the branded `StateBucketName` makes it a compile error too, so this spec is the
   * runtime half of a guard that now has both.
   */
  it("points dedupe markers at the STATE bucket and events at the EVENT bucket — never the same one", () => {
    const { deps } = depsWith()
    const [integration] = registerGithub(registration)(deps)
    const wired = integration instanceof GithubWebhookIntegration ? integration : undefined
    expect(wired?.deps.dedupe.bucket).toBe(stateBucket)
    expect(wired?.deps.events.bucket).toBe(eventBucket)
    expect(wired?.deps.dedupe.bucket).not.toBe(wired?.deps.events.bucket)
  })

  it("never addresses a marker under a key that could sort above an event key in the event bucket", () => {
    const { deps } = depsWith()
    const [integration] = registerGithub(registration)(deps)
    const wired = integration instanceof GithubWebhookIntegration ? integration : undefined
    const markerKey = wired?.deps.dedupe.keyFor("some-delivery-id") ?? ""
    expect(markerKey.startsWith(githubRegistrationDefaults.deliveryPrefix)).toBe(true)
    // The marker key sorts above a 2026-… event key, which is precisely why it must live elsewhere.
    expect(markerKey > "2026-07-19T19:02:11.000Z").toBe(true)
    expect(wired?.deps.dedupe.bucket).not.toBe(wired?.deps.events.bucket)
  })
})
