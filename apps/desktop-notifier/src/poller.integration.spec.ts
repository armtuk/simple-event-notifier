import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { buildEventKey, parseEvent } from "@personal-events/event-model"
import { Either } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { pollOnce } from "./poller.ts"
import { createS3Client, probeCredentials } from "./s3-client.ts"
import { readExemplarText, readLocalExemplarText } from "./testing/exemplars.ts"

/**
 * The real-bucket integration suite `.agents/tests.md` asks for: no fake client, real `PutObject`
 * fixtures tracked by key and torn down by key (never a bucket wipe).
 *
 * It is **opt-in** because it writes to a real bucket. Run it with a disposable bucket:
 *
 *   TEST_EVENT_BUCKET=events.dev.personal-events.fifthdimensionengineering.com \
 *   AWS_REGION=us-east-1 pnpm --filter @personal-events/desktop-notifier test
 */

const bucket = process.env.TEST_EVENT_BUCKET
const region = process.env.AWS_REGION ?? "us-east-1"
const runId = `it-${Date.now()}`

const writtenKeys: string[] = []

const s3 = createS3Client(region)

const put = async (key: string, body: string): Promise<void> => {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }))
  writtenKeys.push(key)
}

const keyFor = (fileName: string): string => {
  const event = Either.getOrThrow(parseEvent(JSON.parse(readExemplarText(fileName))))
  return buildEventKey({ ...event, source: runId })
}

afterAll(async () => {
  await writtenKeys.reduce(
    async (chain, key) => chain.then(async () => void (await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })))),
    Promise.resolve()
  )
})

describe.skipIf(bucket === undefined)("pollOnce against a real bucket", () => {
  it("has usable credentials before anything else is attempted", async () => {
    expect((await probeCredentials(s3))._tag).toBe("CredentialsAvailable")
  })

  it("returns only the objects written after the mark, and advances to the highest key", async () => {
    const before = keyFor("valid-github-pull-request.json")
    const after = keyFor("valid-agent-notification.json")
    await put(before, readExemplarText("valid-github-pull-request.json"))
    await put(after, readExemplarText("valid-agent-notification.json"))

    const result = await pollOnce(s3, bucket ?? "", before)
    expect(result.objects.map(object => object.key)).toContain(after)
    expect(result.objects.map(object => object.key)).not.toContain(before)
    expect(result.mark >= after).toBe(true)
  })

  it("returns a malformed object's body rather than failing the whole poll", async () => {
    const key = `${runId}-malformed.json`
    await put(key, readLocalExemplarText("not-json.txt"))
    const result = await pollOnce(s3, bucket ?? "", `${runId}-l`)
    expect(result.objects.map(object => object.key)).toContain(key)
  })
})
