import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Either } from "effect"
import type { Event } from "../event.ts"
import { parseEvent } from "../parse.ts"

/**
 * Test-support surface, published from this package so **every** consumer's suite runs against the
 * contract's canonical data rather than against a copy that can silently drift. It is reached
 * through the `@personal-events/event-model/testing` subpath, not the package root, so nothing in a
 * production bundle can pull the filesystem reads in.
 */

export interface ExemplarReader {
  readonly readText: (fileName: string) => string
  readonly readJson: (fileName: string) => unknown
}

/** Binds a reader to one `exemplars/` directory, so a consumer can add its own without re-implementing this. */
export const exemplarReader = (directory: string): ExemplarReader => ({
  readText: (fileName: string): string => readFileSync(join(directory, fileName), "utf-8"),
  readJson: (fileName: string): unknown => JSON.parse(readFileSync(join(directory, fileName), "utf-8"))
})

const eventModelExemplars = /*#__PURE__*/ exemplarReader(join(import.meta.dirname, "..", "..", "exemplars"))

export const readExemplarText = (fileName: string): string => eventModelExemplars.readText(fileName)

export const readExemplar = (fileName: string): unknown => eventModelExemplars.readJson(fileName)

export const readExemplarEvent = (fileName: string): Event => Either.getOrThrow(parseEvent(readExemplar(fileName)))
