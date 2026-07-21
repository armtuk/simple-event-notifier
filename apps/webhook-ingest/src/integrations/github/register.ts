import { S3Client } from "@aws-sdk/client-s3"
import { SSMClient } from "@aws-sdk/client-ssm"
import type { StateBucketName } from "@personal-events/event-sink"
import { loadGithubConfig } from "@personal-events/github"
import { Either } from "effect"
import type { IntegrationFactory } from "../../composition.ts"
import type { WebhookIntegration } from "../../webhook-integration.ts"
import { DeliveryDedupeRepository } from "./delivery-dedupe-repository.ts"
import { GithubWebhookIntegration } from "./github-integration.ts"
import { WebhookSecretRepository } from "./webhook-secret-repository.ts"

/**
 * Wires GitHub into the ingest registry. This runs **once per cold start**, inside the composition
 * root, so the SDK clients and the compiled mapping config are reused across warm invocations.
 *
 * The mapping config is validated here and a failure **disables the integration** rather than
 * crashing the function. A config typo would otherwise take down every provider, including ones
 * whose config is fine — and the resulting 404 is at least a visible, diagnosable answer with the
 * reason in the log, where a failed import is neither.
 */

export interface GithubRegistrationConfig {
  readonly region: string
  readonly secretParameterName: string
  readonly stateBucketName: StateBucketName
  readonly deliveryPrefix: string
}

export const githubRegistrationDefaults = {
  secretParameterName: "/personal-events/github/webhook-secret",
  deliveryPrefix: "deliveries/github"
} as const

export const registerGithub =
  (config: GithubRegistrationConfig): IntegrationFactory =>
  ({ events, logger }): readonly WebhookIntegration[] => {
    const compiled = loadGithubConfig()
    if (Either.isLeft(compiled)) {
      logger.error("github integration disabled: its mapping config is invalid", { reason: describeConfigFailure(compiled.left) })
      return []
    }
    logger.info("github integration registered", {
      rules: compiled.right.ruleCount,
      secretParameter: config.secretParameterName,
      deliveryPrefix: `${config.stateBucketName}/${config.deliveryPrefix}`
    })
    return [
      new GithubWebhookIntegration({
        secrets: new WebhookSecretRepository(new SSMClient({ region: config.region }), config.secretParameterName),
        dedupe: new DeliveryDedupeRepository(new S3Client({ region: config.region }), config.stateBucketName, config.deliveryPrefix),
        events,
        config: compiled.right,
        now: (): string => new Date().toISOString(),
        logger
      })
    ]
  }

/** Both config failure shapes carry a `reason`; the processor failure also names what it asked for. */
const describeConfigFailure = (failure: { readonly _tag: string; readonly reason?: string }): string =>
  `${failure._tag}: ${failure.reason ?? "see the mapping config"}`
