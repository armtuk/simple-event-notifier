import {it, expect, describe} from "vitest"
import {FileSystemService} from "./file-system.service.ts"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import {type FileListResult, FileService, FileServiceError} from "./file-interface.ts";

describe("FileSystemService", () => {

  const MainLayer = FileSystemService.layer("./test/fileData1")
    .pipe(Layer.provide(NodeServices.layer))

  const serviceIt = <A, E>(f: (service: FileService["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* FileService
        return yield* f(service)
      }).pipe(Effect.provide(MainLayer))
    )

  it("should have two date paths when listing since 9/26", async () => {
    const r = await serviceIt(service => service.datePaths())

    expect(r.length).toBe(2)
    expect(r).toStrictEqual([
      "2026/09/26",
      "2026/09/27"
    ])
  })

  it("should list files since a date and return 2 files for 9/27", async () => {
     const l = await serviceIt((service) => Effect.gen(function*() {
       return yield*service.listSince(new Date("2026-09-27T18:00:00Z"))
     }))

    expect(l.isSuccess).toBeTruthy()
    if (l.isSuccess) {
      expect(l.files.length).toBe(2)
    }
  })

  it("should list files since 09/27 19:00 and return 1 file", async () => {
    const l: FileListResult = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* FileService
        return yield*service.listSince(new Date("2026-09-27T19:00:00Z"))
      }).pipe(
        Effect.provide(MainLayer)
      )
    )

    expect(l.isSuccess).toBeTruthy()
    if (l.isSuccess) {
      expect(l.files.length).toBe(1)
    }
  })

  it("should list files since 09/26 15:00 and return 4 files", async () => {
    const l: FileListResult = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* FileService
        return yield*service.listSince(new Date("2026-09-26T15:00:00Z"))
      }).pipe(
        Effect.provide(MainLayer)
      )
    )

    expect(l.isSuccess).toBeTruthy()
    if (l.isSuccess) {
      expect(l.files.length).toBe(4)
    }
  })
})