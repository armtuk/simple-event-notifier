import {Effect} from "effect"
import {Layer, FileSystem, Path} from "effect";
import {
  type FileListResult,
  fileListResult,
  FileService,
  FileServiceError,
  type FileWriteResult,
  fileWriteResult,
  pathFromDate, toError
} from "./file-interface.ts";

export const fileSystemService = (basePath: string) => Effect.gen(function*() {

  const fs: FileSystem.FileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path

  const writeFile = (toPath: string, data: any): Effect.Effect<FileWriteResult, FileServiceError> => {
    const fullPath = paths.join(basePath, pathFromDate(new Date()) ,toPath)
    return fs.writeFileString(fullPath, JSON.stringify(data, null, 2))
      .pipe(
        Effect.as(fileWriteResult(true)),
        Effect.mapError(toError(fullPath))
      )
  }

  const listIn = (path: string) => {
    return fs.readDirectory(paths.join(basePath, path), {recursive: false})
  }

  const datePaths = (): Effect.Effect<string[], FileServiceError> =>
    Effect.gen(function*() {
      const years = yield* listIn("")
      const perYear = yield* Effect.forEach(years, year =>
        Effect.gen(function*() {
          const months = yield* listIn(year)
          const perMonth = yield* Effect.forEach(months, month =>
            listIn(paths.join(year, month)).pipe(
              Effect.map(days => days.map(day => `${year}/${month}/${day}`))
            )
          )
          return perMonth.flat()
        })
      )
      return perYear.flat().sort()
    }).pipe(Effect.mapError(toError(basePath)))

  const listSince = (d: Date): Effect.Effect<FileListResult, FileServiceError> => Effect.gen(function*() {
    const strDate = d.toISOString()
    const pathList = yield*datePaths()
    return yield*Effect.forEach(pathList, elem => fs.readDirectory(paths.join(basePath, elem), {recursive: true}))
      .pipe(
        Effect.map(x => x.flatMap(e => e)),
        Effect.map(x => x.filter(e => strDate.localeCompare(e.split("\\.")[0]) < 0)),
        Effect.map(x => fileListResult(x)),
        Effect.mapError(toError(basePath))
      )
  })

  return {writeFile, listSince, datePaths}
})

export const FileSystemService = {
  layer: (basePath: string) => Layer.effect(FileService, fileSystemService(basePath))
}