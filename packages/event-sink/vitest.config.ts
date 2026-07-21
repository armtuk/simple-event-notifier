import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "event-sink", include: ["src/**/*.spec.ts"] } })
