import {Effect} from "effect"
import {FileService} from "./file-interface.ts";

export const eventListService = Effect.gen(function*() {
  const fileService = yield*FileService
})