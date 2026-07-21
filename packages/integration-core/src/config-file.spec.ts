import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Either } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readConfigFile } from "./config-file.ts"
import { loadMappingConfig } from "./loader.ts"
import { configExemplarPath, readConfigExemplarText } from "./testing/exemplars.ts"

/**
 * The one I/O function in the package, exercised against real files in a real temp directory
 * rather than a mocked `fs` — the failure modes that matter here (a missing file, bytes that are
 * not JSON) are properties of the filesystem, and a mock would only assert that the mock works.
 */

let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "integration-core-config-"))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("readConfigFile", () => {
  it("reads a real config file into a value the loader accepts", async () => {
    const raw = Either.getOrThrow(await readConfigFile(configExemplarPath("valid-config-minimal.json")))
    expect(Either.isRight(loadMappingConfig(raw, { knownProcessors: [] }))).toBe(true)
  })

  it("returns a typed failure naming the path when the file does not exist", async () => {
    const missing = join(scratch, "no-such-config.json")
    const failure = Either.getOrThrow(Either.flip(await readConfigFile(missing)))
    expect(failure._tag).toBe("ConfigParseError")
    expect(failure.reason).toContain(missing)
  })

  it("returns a typed failure naming the path when the bytes are not JSON", async () => {
    const broken = join(scratch, "broken.json")
    await writeFile(broken, "{ this is not json", "utf-8")
    const failure = Either.getOrThrow(Either.flip(await readConfigFile(broken)))
    expect(failure.reason).toContain("not valid JSON")
    expect(failure.reason).toContain(broken)
  })

  it("never throws — a directory passed where a file was expected is still an Either", async () => {
    expect(Either.isLeft(await readConfigFile(scratch))).toBe(true)
  })

  it("round-trips the exemplar bytes without reinterpreting them", async () => {
    const raw = Either.getOrThrow(await readConfigFile(configExemplarPath("valid-config-minimal.json")))
    expect(raw).toStrictEqual(JSON.parse(readConfigExemplarText("valid-config-minimal.json")))
  })
})
