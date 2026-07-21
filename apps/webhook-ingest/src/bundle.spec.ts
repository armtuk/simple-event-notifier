import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runNodeIn } from "./testing/run-bundle.ts"

/**
 * The **deployment artifact** is what AWS actually runs: Terraform's `archive_file` zips `dist/`
 * verbatim, with no `node_modules` beside it. Every other spec in this app imports TypeScript source
 * through vitest, where the whole workspace's `node_modules` is resolvable — so none of them can see
 * whether the emitted bundle would survive on its own.
 *
 * Two real defects hid in exactly that blind spot, and both made the function fail as
 * `Runtime.ImportModuleError` **before any code of ours ran**, where no handler-level error handling
 * could catch it and no log line of ours would appear:
 *
 * 1. Without `noExternal`, the bundle imports bare specifiers that the zip has nothing to resolve.
 * 2. With `noExternal` but no `createRequire` banner, esbuild's CJS interop (winston →
 *    `@colors/colors`) emits a `__require` shim that throws `Dynamic require of "util" is not
 *    supported` at import time.
 *
 * The bundle is copied **outside the repository** first. Importing it in place would walk up to the
 * workspace `node_modules` and pass even when broken — which is precisely why this went unnoticed.
 */

const distDir = fileURLToPath(new URL("../dist", import.meta.url))

let stagedDist: string

beforeAll(async () => {
  stagedDist = await mkdtemp(join(tmpdir(), "webhook-ingest-bundle-"))
  await cp(distDir, join(stagedDist, "dist"), { recursive: true })
}, 30_000)

afterAll(async () => {
  await rm(stagedDist, { recursive: true, force: true })
})

describe("the Lambda deployment artifact", () => {
  it("imports cleanly with no node_modules beside it — the shape the zip actually has", async () => {
    const result = await runNodeIn(stagedDist, `await import(${JSON.stringify(join(stagedDist, "dist", "handler.js"))})`, {
      EVENT_BUCKET_NAME: "events.example.com",
      STATE_BUCKET_NAME: "state.example.com"
    })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  it("resolves every dependency at bundle time rather than at import time", async () => {
    const result = await runNodeIn(stagedDist, `await import(${JSON.stringify(join(stagedDist, "dist", "handler.js"))})`, {
      EVENT_BUCKET_NAME: "events.example.com",
      STATE_BUCKET_NAME: "state.example.com"
    })
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND")
  })

  it("survives esbuild's CJS interop, which throws on a bare built-in without the createRequire banner", async () => {
    const result = await runNodeIn(stagedDist, `await import(${JSON.stringify(join(stagedDist, "dist", "handler.js"))})`, {
      EVENT_BUCKET_NAME: "events.example.com",
      STATE_BUCKET_NAME: "state.example.com"
    })
    expect(result.stderr).not.toContain("Dynamic require")
  })

  it("exports a callable handler from the emitted file, not merely a parseable module", async () => {
    const result = await runNodeIn(
      stagedDist,
      `const m = await import(${JSON.stringify(join(stagedDist, "dist", "handler.js"))}); if (typeof m.handler !== "function") { throw new Error("handler is " + typeof m.handler) }`,
      { EVENT_BUCKET_NAME: "events.example.com", STATE_BUCKET_NAME: "state.example.com" }
    )
    expect(result.code).toBe(0)
  })
})
