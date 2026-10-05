import type { Trigger } from "./channel.ts"
import { matchKey } from "./channel.ts"
import type { CompiledConfig } from "./compile.ts"
import type { Output } from "./mapping-config.ts"

/**
 * Classification, separated from event construction so that "which rule fired" is an answerable
 * question. `transform` needs only the `Output`; an **edge** needs more — AWE-156's webhook
 * integration logs a `warn` when a delivery classified to the fallback, because an unmapped
 * event-name is a config gap the operator should see, even though it is emphatically *not* an
 * error (the event is still written; nothing is ever dropped for being unrecognised).
 *
 * Returning `matched` alongside the output is what lets the edge distinguish those two cases
 * without re-deriving the lookup or comparing outputs by value — two different triggers may
 * legitimately map to the same `Output`, so equality with `fallback` would be a false signal.
 */

export interface Classification {
  readonly output: Output
  readonly matchKey: string
  readonly matched: boolean
}

export const classify = (compiled: CompiledConfig, trigger: Trigger): Classification => {
  const key = matchKey(trigger)
  const output = compiled.lookup.get(key)
  return output === undefined ? { output: compiled.fallback, matchKey: key, matched: false } : { output, matchKey: key, matched: true }
}
