import { defineConfig } from "tsup"

/**
 * The output of this build is the Lambda deployment package: Terraform's `archive_file` zips
 * `dist/` verbatim, so what is here is what runs.
 *
 * Bundling is total (`noExternal`), including the AWS SDK. The SDK is present in the managed
 * runtime, so bundling it is a deliberate size-for-determinism trade: the alternative is a function
 * whose behaviour changes when AWS rolls the runtime's SDK minor version, which is exactly the class
 * of surprise a permanent event log should not be exposed to. Bundling is also what makes the zip
 * work at all — the archive carries `dist/` and no `node_modules`.
 *
 * ## Why the `createRequire` banner is not optional
 *
 * `winston` and its transitive `@colors/colors` are **CommonJS**. Rolling CJS into an **ESM** output
 * makes esbuild emit a `__require` shim, and that shim *throws* for anything it cannot resolve at
 * bundle time — including bare Node built-ins like `util`. Without this banner the emitted file dies
 * with `Error: Dynamic require of "util" is not supported` on **import**, so the Lambda fails as
 * `Runtime.ImportModuleError` before a single line of ours runs, and no amount of handler-level
 * error handling can catch it. The banner supplies a real `require`, so the CJS interop resolves
 * built-ins the way Node does.
 *
 * `apps/github-poller/tsup.config.ts` carries the same banner for the same reason. Both are verified
 * by importing the emitted artifact from a directory with no `node_modules` — see each app's
 * `bundle.spec.ts`, which is the only test that can catch this class.
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
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);"
  }
})
