import { join } from "node:path"
import { exemplarReader } from "@personal-events/event-model/testing"

/**
 * This package's captured GitHub payloads, read through the contract's published `exemplarReader`.
 * They are genuinely this package's concern — GitHub's wire shapes — as distinct from the canonical
 * *event* bodies, which stay in `@personal-events/event-model` so no consumer can drift from them.
 */

const githubExemplars = /*#__PURE__*/ exemplarReader(join(import.meta.dirname, "..", "..", "exemplars"))

export const readGithubExemplar = (fileName: string): unknown => githubExemplars.readJson(fileName)

export const readGithubExemplarText = (fileName: string): string => githubExemplars.readText(fileName)
