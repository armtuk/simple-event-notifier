import { githubEventsApiToEvent, githubNotificationToEvent, normalizeEventsApi, normalizeNotification } from "@personal-events/github"
import type { CompiledConfig } from "@personal-events/integration-core"
import { transform } from "@personal-events/integration-core"
import { eventsApiKey, notificationKey } from "./dedupe.ts"
import type { SourceDefinition } from "./source-cycle.ts"
import { type GithubSourceRepository, sourceNames } from "./source-repositories.ts"

/**
 * The two source definitions: everything that differs between polling the Notifications inbox and
 * polling the Events API, in one place, so `source-cycle.ts` can be written once.
 *
 * `githubNotificationToEvent` / `githubEventsApiToEvent` exist and would be shorter, but they fuse
 * normalize and classify into one step and lose the distinction between "GitHub sent us something we
 * cannot read" and "we cannot turn a readable item into a canonical event". The cycle logs those
 * differently, so the two halves stay separate here.
 */

export const notificationsSource = (repository: GithubSourceRepository, config: CompiledConfig): SourceDefinition => ({
  name: sourceNames.notifications,
  repository,
  keyOf: notificationKey,
  normalize: normalizeNotification,
  toEvent: transform(config),
  /**
   * The inbox's `since` advances to the newest `updated_at` in the page, so the next poll does not
   * re-scan from the beginning. It is deliberately **not** advanced past what was actually seen: an
   * item updated in the same second as the newest one would otherwise be skipped, and the dedupe set
   * — not the cursor — is what prevents re-delivery of what has already been written.
   */
  nextSince: (items: readonly unknown[]): string | undefined => newestUpdatedAt(items)
})

export const eventsSource = (repository: GithubSourceRepository, config: CompiledConfig): SourceDefinition => ({
  name: sourceNames.events,
  repository,
  keyOf: eventsApiKey,
  normalize: normalizeEventsApi,
  toEvent: transform(config),
  /** The Events API has no `since` parameter; its `ETag` is the whole cursor. */
  nextSince: (): string | undefined => undefined
})

/** Re-exported so a host that only wants the fused form can still reach it. */
export { githubEventsApiToEvent, githubNotificationToEvent }

const newestUpdatedAt = (items: readonly unknown[]): string | undefined =>
  items
    .map(item => stringField(item, "updated_at"))
    .filter((value): value is string => value !== undefined)
    .reduce<string | undefined>((newest, value) => (newest === undefined || value > newest ? value : newest), undefined)

const stringField = (item: unknown, field: string): string | undefined =>
  typeof item === "object" && item !== null && field in item && typeof (item as Record<string, unknown>)[field] === "string"
    ? String((item as Record<string, unknown>)[field])
    : undefined
