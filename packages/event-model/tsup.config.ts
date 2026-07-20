import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true
})
