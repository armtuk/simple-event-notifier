import { defineConfig } from "tsup"

/**
 * The output is the poller's Lambda deployment package: Terraform's `archive_file` zips `dist/`
 * verbatim, so what is here is what runs, and there is no `node_modules` beside it.
 *
 * Bundling is total (`noExternal`): the four workspace packages, `effect`, `winston` and the AWS SDK
 * all go into one file — the same trade `apps/webhook-ingest` documents (a larger artifact for a
 * function whose behaviour cannot shift when AWS rolls the managed runtime's SDK). Without it the
 * zip would carry bare imports it has nothing to resolve, and the function would die on
 * `ERR_MODULE_NOT_FOUND` before logging a line.
 *
 * The `createRequire` banner is equally load-bearing: `winston` and its transitive `@colors/colors`
 * are CommonJS, and rolling CJS into an ESM output makes esbuild emit a `__require` shim that
 * **throws** for bare Node built-ins (`Dynamic require of "util" is not supported`) at import time —
 * i.e. before any code of ours runs. `bundle.spec.ts` pins both halves by importing the emitted file
 * from a directory with no `node_modules`.
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
