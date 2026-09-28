import {it, expect, describe} from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import {type FileListResult, FileService} from "../../file-interface.ts";
import {S3FileService} from "./S3-file.service.ts";

describe("S3FileService", async () => {

  const MainLayer = S3FileService.layer("aturner-events")
    .pipe(Layer.provide(NodeServices.layer))

  it("should list files since a date", async () => {
     const l: FileListResult = await Effect.runPromise(
       Effect.gen(function*() {
         const service = yield* FileService
         return yield*service.listSince(new Date())
       }).pipe(
         Effect.provide(MainLayer)
       )
     )

    expect(l.isSuccess).toBeTruthy()

  })
})