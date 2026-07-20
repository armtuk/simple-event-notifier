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
})
