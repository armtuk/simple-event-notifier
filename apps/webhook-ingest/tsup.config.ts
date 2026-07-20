import { defineConfig } from "tsup"

/**
 * The output of this build is the Lambda deployment package: Terraform's `archive_file` zips
 * `dist/` verbatim, so what is here is what runs.
 *
 * Bundling is total (`noExternal`) — **everything**, including the AWS SDK. The SDK is present in the
 * managed runtime, so bundling it is a deliberate size-for-determinism trade: the alternative is a
 * function whose behaviour changes when AWS rolls the runtime's SDK minor version, which is exactly
 * the class of surprise a permanent event log should not be exposed to.
 */
export default defineConfig({
  entry: ["src/handler.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  splitting: false,
  clean: true,
  noExternal: [/.*/]
})
