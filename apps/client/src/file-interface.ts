import {Effect, Context, Schema} from "effect"
import {type Event} from "./model/event.schema.ts"

export interface FileSpec {
  uri: string
}

export interface EventWriteSuccessResult {
  _tag: "EventWriteSuccessResult"
  isSuccess: true
  uri: string
}

export interface EventWriteFailureResult {
  _tag: "EventWriteFailureResult"
  isSuccess: false
  uri: string
  error: any
}

export type EventWriteResult = EventWriteSuccessResult | EventWriteFailureResult

export interface FileWriteSuccessResult {
  _tag: "FileWriteSuccessResult"
  isSuccess: true
}

export interface FileWriteFailureResult {
  _tag: "FileWriteFailureResult"
  isSuccess: false
}

export type FileWriteResult = FileWriteSuccessResult | FileWriteFailureResult

export const fileWriteResult = (isSuccess: boolean): FileWriteResult =>
  isSuccess ? ({_tag: "FileWriteSuccessResult", isSuccess: true})
    : ({_tag: "FileWriteFailureResult", isSuccess: false})


export interface FileListSuccessResult {
  isSuccess: true
  readonly files: ReadonlyArray<string>
}
export interface FileListFailureResult {
  isSuccess: false
}
export const fileListResult = (c: string[]) => ({
  isSuccess: true,
  files: c
})

export type FileListResult = FileListSuccessResult | FileListFailureResult

export class FileServiceError extends Schema.TaggedError<FileServiceError>()("FileServiceError", {
  path: Schema.String,
  message: Schema.String
}) {}

export class FileService extends Context.Service<FileService, {
  readonly writeFile: (path: string, data: any) => Effect.Effect<FileWriteResult, FileServiceError>
  readonly listSince: (day: Date) => Effect.Effect<FileListResult, FileServiceError>
  readonly datePaths: () => Effect.Effect<string[], FileServiceError>
}>()("app/FileService") {}

const date = (d: Date) => ({
  year: String(d.getFullYear()),
  month: String(d.getMonth() + 1).padStart(2, "0"),
  day: String(d.getDate()).padStart(2, "0"),
})

export const pathFromDate = (d: Date) => {
  const e = date(d)
  return `${e.year}/${e.month}/${e.day}`
}

export const toError = (p: string) => (e: { message: string }) =>
  new FileServiceError({ path: p, message: e.message })


/**
 * 2026-06-28T18:44:30.123Z.alert.p5.github.new-pull-request.json
 * @param e an Event
 */
export const pathFromEvent = (e: Event) => {
  const datePath = pathFromDate(e.timestamp)
  return `${datePath}/${e.timestamp.toString()}.${e.eventType}.p${e.priority}.${e.source}.${e.name}.json`
}