import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "event-model", include: ["src/**/*.spec.ts"] } })
