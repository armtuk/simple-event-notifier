import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "github", include: ["src/**/*.spec.ts"] } })
