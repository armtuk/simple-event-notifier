import type { WebhookIntegration } from "./webhook-integration.ts"

/**
 * Route → integration, as a lookup rather than a chain of comparisons. Adding an integration is
 * adding an entry; the handler and the infrastructure are untouched, because API Gateway routes
 * `POST /{integration}` as one wildcard rather than one route per provider.
 *
 * Pure and value-based: the registry is *built* by the composition root and *read* here, so a spec
 * can drive the handler with a stub integration without any construction of AWS clients.
 */

export type IntegrationRegistry = Readonly<Record<string, WebhookIntegration>>

/**
 * Built on a **null prototype**. The lookup key is a path segment supplied by an anonymous caller on
 * an internet-facing endpoint, so a plain object literal would resolve `POST /toString` to
 * `Object.prototype.toString` — a function the handler would then invoke as an integration. A null
 * prototype removes the whole class of that, rather than guarding one key at a time.
 */
export const createRegistry = (integrations: readonly WebhookIntegration[]): IntegrationRegistry =>
  Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, WebhookIntegration>,
      Object.fromEntries(integrations.map(integration => [integration.source, integration]))
    )
  )

export const integrationFor = (registry: IntegrationRegistry, path: string): WebhookIntegration | undefined => registry[path]

export const registeredSources = (registry: IntegrationRegistry): readonly string[] => Object.keys(registry)
