import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadState, saveState, seedMark } from "./state.ts"

/** Real filesystem, not a mocked one — the point of this module is the atomic-rename behaviour. */

let directory = ""

const statePath = (): string => join(directory, "desktop-notifier.json")

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-events-state-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("loadState", () => {
  it("reports NoState on first run rather than failing", async () => {
    expect((await loadState(statePath()))._tag).toBe("NoState")
  })

  it("round-trips a saved mark", async () => {
    await saveState(statePath(), { mark: "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json" })
    const loaded = await loadState(statePath())
    expect(loaded._tag).toBe("LoadedState")
    expect(loaded._tag === "LoadedState" ? loaded.state.mark : "").toBe("2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json")
  })

  it("reports an unusable state file with the path and the reason instead of throwing", async () => {
    await writeFile(statePath(), "{ truncated", "utf-8")
    const loaded = await loadState(statePath())
    expect(loaded._tag).toBe("LoadStateFailure")
    expect(loaded._tag === "LoadStateFailure" ? loaded.message : "").toContain(statePath())
  })

  it("rejects a state file whose shape is wrong", async () => {
    await writeFile(statePath(), JSON.stringify({ highWaterMark: "wrong-field" }), "utf-8")
    expect((await loadState(statePath()))._tag).toBe("LoadStateFailure")
  })
})

describe("saveState", () => {
  it("creates the containing directory when it does not exist yet", async () => {
    const nested = join(directory, "personal-events", "desktop-notifier.json")
    await saveState(nested, { mark: "a" })
    expect((await loadState(nested))._tag).toBe("LoadedState")
  })

  it("leaves no temp files behind, so the rename actually happened", async () => {
    await saveState(statePath(), { mark: "a" })
    await saveState(statePath(), { mark: "b" })
    expect(await readdir(directory)).toStrictEqual(["desktop-notifier.json"])
  })

  it("overwrites the previous mark rather than appending", async () => {
    await saveState(statePath(), { mark: "a" })
    await saveState(statePath(), { mark: "b" })
    const loaded = await loadState(statePath())
    expect(loaded._tag === "LoadedState" ? loaded.state.mark : "").toBe("b")
  })
})

describe("seedMark", () => {
  it("seeds from now so a first run does not replay the bucket's history", () => {
    expect(seedMark(new Date("2026-07-19T09:15:02.000Z"))).toBe("2026-07-19T09:15:02.000Z")
  })

  it("seeds a mark that sorts before any event written after it", () => {
    const mark = seedMark(new Date("2026-07-19T09:15:02.000Z"))
    expect("2026-07-19T09:15:03.000Z.alert.p1.github.push.json" > mark).toBe(true)
  })
})
