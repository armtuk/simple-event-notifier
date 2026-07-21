import { isoInstantPattern } from "@personal-events/event-model"
import { Either } from "effect"

/**
 * GitHub's timestamps are ISO-8601 but not the *exact* ISO-8601 the event contract requires: the
 * Notifications API emits `updated_at` at **second** precision (`2026-07-19T18:44:30Z`), while the
 * contract's `IsoInstant` demands exactly three fractional digits, because a variable-width fraction
 * makes object keys stop sorting chronologically.
 *
 * ## The consequence, recorded rather than solved
 *
 * Widening a second to `.000` means **every notification GitHub updated within the same second
 * carries the same millisecond**, and therefore the same leading key segment. For this producer
 * same-instant siblings are the *norm*, not a coincidence: a batch of notifications is exactly what
 * one poll returns.
 *
 * That collides with the known hazard in `packages/event-model/README.md` § "Key order is not write
 * order" — a consumer using a bare `StartAfter` high-water mark can advance past a sibling that was
 * written after the mark was taken, and never see it again. **This is not fixed here.** The fix
 * (a lookback poll window plus a delivered-key set) depends on an unmade product decision about
 * delivery semantics — at-most-once vs retry-until-delivered vs quarantine-and-continue. It is
 * recorded in `.agents/plans/github-integration/feature.md` and in the feature ADR for the user to
 * rule on.
 *
 * What this module *can* do is refuse to make it worse: it never invents sub-second detail GitHub
 * did not send. `.000` is honest about the precision that actually arrived.
 */

export const toCanonicalInstant = (value: string): Either.Either<string, string> => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? Either.left(`"${value}" is not a parseable timestamp; expected an ISO-8601 instant such as 2026-07-19T18:44:30Z`)
    : canonicalise(parsed.toISOString(), value)
}

/**
 * `Date.prototype.toISOString()` emits exactly the shape the contract wants, so this check should
 * never fire. It exists because the alternative to checking is writing an object whose key cannot be
 * parsed back — and S3 is permanent.
 */
const canonicalise = (rendered: string, original: string): Either.Either<string, string> =>
  isoInstantPattern.test(rendered)
    ? Either.right(rendered)
    : Either.left(`"${original}" normalised to "${rendered}", which is not a canonical UTC instant with three fractional digits`)
