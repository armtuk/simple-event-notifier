import { defineProject } from "vitest/config"

export default defineProject({ test: { name: "desktop-notifier", include: ["src/**/*.spec.ts"] } })
