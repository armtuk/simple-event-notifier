import { createIngestApp } from "./composition.ts"
import { registerGithub } from "./integrations/github/register.ts"

/**
 * The Lambda entry point. Terraform points `handler = "handler.handler"` at this file, and the
 * module-scope `createIngestApp` call is what makes construction happen once per cold start rather
 * than once per delivery.
 *
 * Nothing else lives here on purpose: this is the only module that touches `process.env`, so every
 * other module in the app is exercisable from a spec without one.
 */

export const { handler } = createIngestApp(process.env, deps =>
  registerGithub({
    region: deps.config.region,
    secretParameterName: deps.config.githubWebhookSecretParam,
    stateBucketName: deps.config.stateBucketName,
    deliveryPrefix: deps.config.githubDeliveryPrefix
  })(deps)
)
