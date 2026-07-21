import { execFile } from "node:child_process"

/**
 * Runs a snippet in a **fresh Node process** whose working directory is a staged copy of `dist/`,
 * with the environment replaced (only `PATH` kept) so an ambient `AWS_*` variable cannot change the
 * outcome. A child process rather than a dynamic `import()` inside vitest, because vitest resolves
 * through the workspace `node_modules` — the very thing that must be absent for the assertion to mean
 * anything.
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

const exitCodeOf = (error: { readonly code?: number | string | null } | null): number =>
  error === null ? 0 : typeof error.code === "number" ? error.code : 1
