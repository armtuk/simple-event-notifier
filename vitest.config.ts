import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    coverage: { provider: "v8", reportsDirectory: "coverage", reporter: ["text", "lcov"] },
    // Winston's Console transport falls back to console.log inside the Vitest worker, and Vitest swallows
    // intercepted console output by default — so logs never reach the terminal. Stop intercepting.
    disableConsoleIntercept: true
  }
})
