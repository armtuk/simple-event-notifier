import {Effect, Path} from "effect"
import {FileService, pathFromDate } from "./file-interface.ts"
import {v7 as uuidv7} from "uuid"
import {Event} from "./model/event.schema.ts"

export const eventWriterService = Effect.gen(function*() {
  const fileService = yield* FileService
  const paths = yield* Path.Path

  const eventPath = (event: Event): string => {
    const path = paths.join(
      pathFromDate(event.timestamp),
      event.clientId
    )

    return path
  }

  const event = (event: Event) => {
    const filePath = eventPath(event)
    fileService.writeFile(filePath, JSON.stringify(event))
  }
})