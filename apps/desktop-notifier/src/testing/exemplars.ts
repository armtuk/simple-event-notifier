import { join } from "node:path"
import { exemplarReader } from "@personal-events/event-model/testing"

/**
 * Event exemplars come from `@personal-events/event-model` itself — they are the contract's data,
 * and a local copy could drift while this suite kept passing against a stale shape. Re-exported so
 * specs have a single import.
 *
 * This package's own `exemplars/` holds only bodies that are genuinely a desktop-notifier concern:
 * objects that turn up in the bucket and are not events at all.
 */

export { readExemplar, readExemplarEvent, readExemplarText } from "@personal-events/event-model/testing"

const localExemplars = /*#__PURE__*/ exemplarReader(join(import.meta.dirname, "..", "..", "exemplars"))

export const readLocalExemplarText = (fileName: string): string => localExemplars.readText(fileName)
