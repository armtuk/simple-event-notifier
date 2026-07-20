import { defineConfig } from "tsup"

export default defineConfig({
  // `testing/exemplars` is a second entry so consumers' suites can reach the contract's canonical
  // exemplars through the package rather than copying them. Splitting keeps the shared schema code
  // in one chunk instead of duplicating it into both bundles.
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
