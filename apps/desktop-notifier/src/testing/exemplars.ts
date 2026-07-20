import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Event, parseEvent } from "@personal-events/event-model"
import { Either } from "effect"

/** Test-support only: reads the representative object bodies under `exemplars/`. */

const exemplarsDir = join(import.meta.dirname, "..", "..", "exemplars")

export const readExemplarText = (fileName: string): string => readFileSync(join(exemplarsDir, fileName), "utf-8")

export const readExemplarEvent = (fileName: string): Event => Either.getOrThrow(parseEvent(JSON.parse(readExemplarText(fileName))))
