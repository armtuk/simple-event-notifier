import { join } from "node:path"
import { exemplarReader } from "@personal-events/event-model/testing"

/**
 * This package's own `exemplars/` directory, bound through the contract's published
 * `exemplarReader` rather than re-implementing the read. These bodies are mapping **configs** —
 * genuinely this package's concern — as distinct from the canonical event bodies, which stay in
 * `@personal-events/event-model` so no consumer can drift from them.
 */

const configExemplars = /*#__PURE__*/ exemplarReader(join(import.meta.dirname, "..", "..", "exemplars"))

export const readConfigExemplar = (fileName: string): unknown => configExemplars.readJson(fileName)

export const readConfigExemplarText = (fileName: string): string => configExemplars.readText(fileName)

export const configExemplarPath = (fileName: string): string => join(import.meta.dirname, "..", "..", "exemplars", fileName)
