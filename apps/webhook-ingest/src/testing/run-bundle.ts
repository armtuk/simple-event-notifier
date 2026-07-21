import { execFile } from "node:child_process"

/**
 * Runs a snippet in a **fresh Node process** whose working directory is the staged copy of `dist/`.
 * A child process rather than a dynamic `import()` inside vitest, because vitest's module graph
 * resolves through the workspace's `node_modules` — which is the very thing that must not be
 * available for this assertion to mean anything.
 *
 * The environment is replaced rather than extended, so an `AWS_*` variable on the developer's
 * machine cannot change the outcome; only `PATH` is kept, because Node needs it.
 */

export interface NodeRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export const runNodeIn = async (cwd: string, script: string, env: Readonly<Record<string, string>> = {}): Promise<NodeRunResult> =>
  new Promise<NodeRunResult>(resolve => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: exitCodeOf(error), stdout: String(stdout), stderr: String(stderr).trim() })
    )
  })

/** `execFile` reports a non-zero exit through the error object's `code`; a clean run passes `null`. */
const exitCodeOf = (error: { readonly code?: number | string | null } | null): number =>
  error === null ? 0 : typeof error.code === "number" ? error.code : 1
