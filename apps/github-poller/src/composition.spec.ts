import { describe, expect, it } from "vitest"
import { runScheduledPoll } from "./composition.ts"
import { capturingLogger, entriesFor, eventPuts, fakeS3, fakeSsm } from "./testing/poller-fixtures.ts"

const NOW = Date.parse("2026-07-20T00:00:00.000Z")

const baseEnv = {
  EVENT_BUCKET_NAME: "events.prod.personal-events.fifthdimensionengineering.com",
  STATE_BUCKET_NAME: "state.prod.personal-events.fifthdimensionengineering.com",
  GITHUB_USERNAME: "alexrmturner",
  AWS_REGION: "us-east-1",
  ENV: "development",
  LOG_LEVEL: "debug"
}

const notifParam = "/personal-events/github/notifications-pat"
const eventsParam = "/personal-events/github/events-pat"

const deadApi = "http://127.0.0.1:9"

const run = async (env: Record<string, string | undefined>, ssmOptions: Parameters<typeof fakeSsm>[0] = {}) => {
  const s3 = fakeS3()
  const ssm = fakeSsm(ssmOptions)
  const log = capturingLogger()
  const summary = await runScheduledPoll(env, {
    s3Client: s3.client,
    ssmClient: ssm.client,
    now: (): number => NOW,
    signal: AbortSignal.timeout(5000),
    logger: log.logger
  })
  return { summary, s3, ssm, log }
}

describe("runScheduledPoll — the composition root", () => {
  it("returns an empty summary and logs when configuration is invalid, without throwing", async () => {
    const { summary, log } = await run({})
    expect(summary).toStrictEqual({ written: 0, polled: [], skipped: [] })
    expect(entriesFor(log.captured, "github poller cannot start")).toHaveLength(1)
  })

  it("reads each configured source's token from SSM before polling", async () => {
    const { ssm } = await run(
      { ...baseEnv, GITHUB_NOTIFICATIONS_PAT_PARAM: notifParam, GITHUB_EVENTS_PAT_PARAM: eventsParam, GITHUB_API_BASE_URL: deadApi },
      { values: { [notifParam]: "classic-pat", [eventsParam]: "any-token" } }
    )
    expect(ssm.reads.toSorted()).toStrictEqual([eventsParam, notifParam].toSorted())
  })

  it("disables a source whose token cannot be read from SSM, and still attempts the other", async () => {
    const { summary, log } = await run(
      { ...baseEnv, GITHUB_NOTIFICATIONS_PAT_PARAM: notifParam, GITHUB_EVENTS_PAT_PARAM: eventsParam, GITHUB_API_BASE_URL: deadApi },
      { values: { [eventsParam]: "any-token" }, failParams: [notifParam] }
    )
    expect(entriesFor(log.captured, "source disabled: its token could not be read from SSM")[0]).toMatchObject({ source: "notifications" })
    expect(summary.polled).toStrictEqual(["events"])
  })

  it("warns and does not read SSM for a source whose parameter is absent", async () => {
    const { ssm, log } = await run(
      { ...baseEnv, GITHUB_EVENTS_PAT_PARAM: eventsParam, GITHUB_API_BASE_URL: deadApi },
      { values: { [eventsParam]: "any-token" } }
    )
    expect(ssm.reads).toStrictEqual([eventsParam])
    expect(
      entriesFor(
        log.captured,
        "notifications source disabled: no GITHUB_NOTIFICATIONS_PAT_PARAM. This endpoint needs a CLASSIC PAT — a fine-grained one cannot call it"
      )
    ).toHaveLength(1)
  })

  it("does nothing — no SSM, no event writes — when no source is configured", async () => {
    const { summary, s3, ssm, log } = await run(baseEnv)
    expect(ssm.reads).toStrictEqual([])
    expect(eventPuts(s3)).toStrictEqual([])
    expect(summary).toStrictEqual({ written: 0, polled: [], skipped: [] })
    expect(entriesFor(log.captured, "no runnable GitHub source this invocation; nothing to poll")).toHaveLength(1)
  })

  it("reports the bucket probe — an inconclusive probe is a warn, not a failed invocation", async () => {
    const { log } = await run(baseEnv)
    // The fake S3 answers HeadBucket with `{}` (reachable), so this is the reachable line.
    expect(entriesFor(log.captured, "event bucket reachable")).toHaveLength(1)
  })
})
