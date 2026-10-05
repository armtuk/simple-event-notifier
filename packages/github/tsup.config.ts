import { defineConfig } from "tsup"

/**
 * `testing/exemplars` is a second entry so a consumer's suite can reach the captured GitHub payloads
 * through the package rather than copying them — the same arrangement `event-model` uses for the
 * contract's exemplars, and for the same reason: a copy drifts. It is a separate subpath, not part
 * of the root export, so nothing in a production bundle pulls the filesystem reads in.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/testing/exemplars.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  splitting: true,
  clean: true
})
