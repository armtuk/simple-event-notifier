import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runNodeIn } from "./testing/run-bundle.ts"

/**
 * The **deployment artifact** — the Lambda zip — is what AWS runs: `archive_file` zips `dist/` with
 * no `node_modules` beside it. Every other spec imports TypeScript source through vitest, where the
 * whole workspace's `node_modules` resolves, so none of them can see whether the emitted bundle
 * survives on its own.
 *
 * Two real defects hid in exactly that blind spot, both making the function fail as
 * `Runtime.ImportModuleError` before any code of ours ran: a missing `noExternal` (bare imports the
 * zip cannot resolve), and — with `noExternal` — esbuild's CJS interop (winston → `@colors/colors`)
 * emitting a `__require` shim that throws on a bare built-in. The bundle is staged **outside the
 * repository** first, because importing it in place would walk up to the workspace `node_modules`
 * and pass even when broken.
 */

const distDir = fileURLToPath(new URL("../dist", import.meta.url))
const handlerImport = (dir: string): string => `const m = await import(${JSON.stringify(join(dir, "dist", "handler.js"))})`

let staged: string

beforeAll(async () => {
  staged = await mkdtemp(join(tmpdir(), "github-poller-bundle-"))
  await cp(distDir, join(staged, "dist"), { recursive: true })
}, 30_000)

afterAll(async () => {
  await rm(staged, { recursive: true, force: true })
})

describe("the Lambda deployment artifact", () => {
  it("imports cleanly with no node_modules beside it — the shape the zip actually has", async () => {
    const result = await runNodeIn(staged, handlerImport(staged))
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  it("resolves every dependency at bundle time rather than at import time", async () => {
    expect((await runNodeIn(staged, handlerImport(staged))).stderr).not.toContain("ERR_MODULE_NOT_FOUND")
  })

  it("survives esbuild's CJS interop, which throws on a bare built-in without the createRequire banner", async () => {
    expect((await runNodeIn(staged, handlerImport(staged))).stderr).not.toContain("Dynamic require")
  })

  it("exports a callable handler from the emitted file", async () => {
    const result = await runNodeIn(
      staged,
      `${handlerImport(staged)}; if (typeof m.handler !== "function") { throw new Error("handler is " + typeof m.handler) }`
    )
    expect(result.code).toBe(0)
  })
})
