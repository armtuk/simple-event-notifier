import { type CompiledConfig, type IntegrationConfigError, loadMappingConfig } from "@personal-events/integration-core"
import { Either } from "effect"
import type { GithubConfigError } from "./errors.ts"
import githubMapping from "./github-mapping.json" with { type: "json" }
import { validateGithubTriggers } from "./mapping-validation.ts"

/**
 * The GitHub classification config, bundled with the package rather than read from disk. Both hosts
 * that need it are awkward places to read a file from — a Lambda's read-only filesystem and a
 * container image — and bundling means the config that shipped is provably the config that runs.
 *
 * It is still **validated at load**, not trusted for being local: an operator editing the JSON is
 * exactly the workflow this feature exists to support, and a typo there must fail at start-up with
 * a message naming the field, not at 3 a.m. with a mis-classified alert. Hosts call this once and
 * fail fast — `integration-core`'s `readConfigFile` remains available for a future host that wants
 * an operator-supplied config outside the bundle.
 *
 * Two gates, GitHub's first: a trigger shape GitHub can never produce is a *worse* defect than a
 * malformed one, because it passes the framework's open schema and then silently never fires.
 */

export const githubMappingConfig: unknown = githubMapping

export type GithubConfigLoadError = IntegrationConfigError | GithubConfigError

export const loadGithubConfig = (knownProcessors: readonly string[] = []): Either.Either<CompiledConfig, GithubConfigLoadError> =>
  loadGithubConfigFrom(githubMappingConfig, knownProcessors)

export const loadGithubConfigFrom = (
  raw: unknown,
  knownProcessors: readonly string[] = []
): Either.Either<CompiledConfig, GithubConfigLoadError> =>
  Either.flatMap(validateGithubTriggers(raw), validated => loadMappingConfig(validated, { knownProcessors }))
