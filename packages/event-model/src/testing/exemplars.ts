import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Test-support only: reads the real, representative event bodies under `exemplars/`. */

const exemplarsDir = join(import.meta.dirname, "..", "..", "exemplars")

export const readExemplarText = (fileName: string): string => readFileSync(join(exemplarsDir, fileName), "utf8")

export const readExemplar = (fileName: string): unknown => JSON.parse(readExemplarText(fileName))
