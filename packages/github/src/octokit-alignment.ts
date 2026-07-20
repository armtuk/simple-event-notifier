import type { components } from "@octokit/openapi-webhooks-types"
import type {
  IssuesEventSchema,
  PullRequestEventSchema,
  PullRequestReviewEventSchema,
  PushEventSchema,
  ReleaseEventSchema
} from "./webhook-payloads.ts"

/**
 * A **compile-time-only** assertion that each subset schema in `webhook-payloads.ts` is a truthful
 * subset of GitHub's own definition. `Aligned<Upstream, Subset>` only resolves when `Upstream`
 * extends `Subset`, so a field GitHub renames, retypes, or makes optional stops the build here
 * rather than surfacing as a rejected delivery in production.
 *
 * This lives in its own module, not in a spec, because it emits **no runtime code at all** — a bare
 * `satisfies` statement in a spec file compiles to a reference to a `declare const` that does not
 * exist at runtime, and the suite dies on import. Types are the right tool for a type claim.
 *
 * Nothing imports these aliases; `tsc --noEmit` checking the file *is* the test.
 */

type Aligned<Upstream extends Subset, Subset> = [Upstream, Subset]

export type PullRequestAligned = Aligned<components["schemas"]["webhook-pull-request-opened"], typeof PullRequestEventSchema.Type>

export type PullRequestReviewAligned = Aligned<
  components["schemas"]["webhook-pull-request-review-submitted"],
  typeof PullRequestReviewEventSchema.Type
>

export type IssuesAligned = Aligned<components["schemas"]["webhook-issues-opened"], typeof IssuesEventSchema.Type>

export type PushAligned = Aligned<components["schemas"]["webhook-push"], typeof PushEventSchema.Type>

export type ReleaseAligned = Aligned<components["schemas"]["webhook-release-published"], typeof ReleaseEventSchema.Type>
