import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  splitting: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" }
})
