import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runTick } from "./daemon.ts"
import { createDaemonLogger } from "./logger.ts"
import { createNotifier } from "./notify.ts"
import { readExemplarText } from "./testing/exemplars.ts"
import { createFakeS3 } from "./testing/fake-s3.ts"

/**
 * The end-to-end proof that raises **real** desktop notifications: object body → `parseEvent` →
 * `toNotification` → the OS. Only the network is stubbed, so this closes the whole chain on a
 * machine with no event bucket provisioned yet.
 *
 * Opt-in, because it puts notifications on the running user's screen:
 *
 *   DESKTOP_NOTIFIER_E2E=1 pnpm --filter @personal-events/desktop-notifier test
 */

const enabled = process.env.DESKTOP_NOTIFIER_E2E === "1"

const goodKey = "2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json"
const badKey = "2026-06-28T18:44:31.000Z.alert.p9.github.new-pull-request.json"
const laterKey = "2026-06-28T18:44:32.000Z.notification.p8.claude-code.prompt-complete.json"

let directory = ""

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-events-e2e-"))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!enabled)("desktop-notifier end to end", () => {
  it("raises real desktop notifications for the valid objects and skips the malformed one", async () => {
    const objects: Readonly<Record<string, string>> = {
      [goodKey]: readExemplarText("valid-github-pull-request.json"),
      [badKey]: readExemplarText("invalid-priority-out-of-range.json"),
      [laterKey]: readExemplarText("valid-agent-notification.json")
    }
    const next = await runTick(
      {
        s3: createFakeS3({ objects }).client,
        bucket: "events.local.personal-events.example.com",
        notifier: createNotifier("auto"),
        logger: createDaemonLogger({ level: "info", env: "dev" }),
        stateFile: join(directory, "state.json")
      },
      { mark: "", consecutiveErrors: 0 }
    )
    expect(next).toStrictEqual({ mark: laterKey, consecutiveErrors: 0 })
  })
})
