import { describe, expect, it } from "vitest"
import { emptyPollerState, type PollerState } from "./poller-state.ts"
import {
  capturingLogger,
  commandsNamed,
  entriesFor,
  fakeS3,
  stateBucket,
  stateKey,
  stateRepositoryOver
} from "./testing/poller-fixtures.ts"

const populated: PollerState = {
  notifications: { cursor: { lastModified: "Sun, 19 Jul 2026 19:02:11 GMT", since: "2026-07-19T19:02:11Z" }, seen: ["1:a"] },
  events: { cursor: { etag: 'W/"abc"' }, seen: ["56138220984"], notBefore: "2026-07-20T00:05:00.000Z" }
}

const repositoryWith = (options: Parameters<typeof fakeS3>[0] = {}) => {
  const log = capturingLogger()
  const s3 = fakeS3(options)
  return { repository: stateRepositoryOver(s3, log.logger), s3, log }
}

describe("PollerStateRepository", () => {
  it("reads the whole state object from the STATE bucket, never the event bucket", async () => {
    const { repository, s3 } = repositoryWith({ initialState: populated })
    await repository.load()
    expect(commandsNamed(s3.commands, "GetObjectCommand")[0]?.input).toStrictEqual({ Bucket: stateBucket, Key: stateKey })
  })

  it("round-trips a populated state including both branches and a notBefore", async () => {
    const { repository } = repositoryWith({ initialState: populated })
    expect(await repository.load()).toStrictEqual(populated)
  })

  it("treats a missing object as a first run, at info rather than warn", async () => {
    const { repository, log } = repositoryWith()
    expect(await repository.load()).toStrictEqual(emptyPollerState)
    expect(entriesFor(log.captured, "no poller state yet; starting from empty state")[0]?.level).toBe("info")
  })

  it("recovers from a malformed state object rather than refusing to run, and warns", async () => {
    const { repository, log } = repositoryWith({ initialState: "{ not json" })
    expect(await repository.load()).toStrictEqual(emptyPollerState)
    expect(entriesFor(log.captured, "poller state object is unreadable; starting from empty state")[0]).toMatchObject({
      level: "warn",
      bucket: stateBucket,
      key: stateKey
    })
  })

  it("recovers from a state object of the wrong SHAPE, not merely bad JSON", async () => {
    const { repository } = repositoryWith({ initialState: JSON.stringify({ notifications: { cursor: {} } }) })
    expect(await repository.load()).toStrictEqual(emptyPollerState)
  })

  it("warns rather than infos when the read failed for a reason other than absence", async () => {
    const { repository, log } = repositoryWith({ failStateRead: Object.assign(new Error("denied"), { name: "AccessDenied" }) })
    expect(await repository.load()).toStrictEqual(emptyPollerState)
    expect(entriesFor(log.captured, "could not read poller state; starting from empty state")[0]?.level).toBe("warn")
  })

  it("saves state as JSON into the state bucket", async () => {
    const { repository, s3 } = repositoryWith()
    await repository.save(populated)
    const put = commandsNamed(s3.commands, "PutObjectCommand")[0]
    expect(put?.input).toMatchObject({ Bucket: stateBucket, Key: stateKey, ContentType: "application/json" })
    expect(JSON.parse(String(put?.input.Body))).toStrictEqual(populated)
  })

  it("survives a save-then-load round trip, which is what makes an invocation resume", async () => {
    const { repository } = repositoryWith()
    await repository.save(populated)
    expect(await repository.load()).toStrictEqual(populated)
  })

  it("propagates a failed save — a cursor that was not persisted must not look persisted", async () => {
    const log = capturingLogger()
    const failing = stateRepositoryOver(
      { client: { send: async () => Promise.reject(new Error("throttled")) } as never, commands: [], stored: new Map() },
      log.logger
    )
    await expect(failing.save(emptyPollerState)).rejects.toThrow("throttled")
  })
})
