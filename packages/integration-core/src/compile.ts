import { matchKey } from "./channel.ts"
import type { MappingConfig, Output } from "./mapping-config.ts"

/**
 * A mapping config is authored as a **list** because a list is what a human edits; it is matched
 * as a **map** because a lookup is what a per-event hot path wants. `compileMappingConfig` is the
 * one-time transform between the two, so `transform` is an O(1) lookup rather than a scan over
 * every rule for every event.
 *
 * Duplicate trigger keys resolve **last-wins**, the ordinary `new Map(entries)` semantic. That is
 * deliberate and asserted in `compile.spec.ts`: a config is data an operator edits, and a
 * later rule overriding an earlier one reads the way an override should. It is not silent — the
 * rule count and the lookup size differ, which is what `ruleCount` exists to expose.
 */

export interface CompiledConfig {
  readonly integration: string
  readonly lookup: ReadonlyMap<string, Output>
  readonly fallback: Output
  readonly ruleCount: number
}

export const compileMappingConfig = (config: MappingConfig): CompiledConfig => ({
  integration: config.integration,
  lookup: new Map(config.rules.map(rule => [matchKey(rule.trigger), rule.output])),
  fallback: config.default,
  ruleCount: config.rules.length
})
