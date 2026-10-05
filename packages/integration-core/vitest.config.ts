import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "integration-core", include: ["src/**/*.spec.ts"] } })
