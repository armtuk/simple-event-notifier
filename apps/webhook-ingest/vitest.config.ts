import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "webhook-ingest", include: ["src/**/*.spec.ts"] } })
