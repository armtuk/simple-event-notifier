import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Either, ParseResult, Schema } from "effect"

/**
 * Persist: the high-water mark across restarts, so a restart never re-notifies for events already
 * delivered. Written temp-then-rename **within the same directory** — `rename` is atomic on POSIX
 * only when source and target share a filesystem, so a temp file in /tmp would not do.
 */

const StateSchema = /*#__PURE__*/ Schema.Struct({ mark: Schema.String }).annotations({ identifier: "DaemonState" })

export type DaemonState = typeof StateSchema.Type

export interface LoadedState {
  readonly _tag: "LoadedState"
  readonly state: DaemonState
}

export interface NoState {
  readonly _tag: "NoState"
}

export interface LoadStateFailure {
  readonly _tag: "LoadStateFailure"
  readonly message: string
}

export type LoadStateResult = LoadedState | NoState | LoadStateFailure

export const loadState = async (path: string): Promise<LoadStateResult> =>
  readFile(path, "utf-8")
    .then((text): LoadStateResult => toLoadResult(path, text))
    .catch((cause: unknown): LoadStateResult => (isNotFound(cause) ? { _tag: "NoState" } : failure(path, cause)))

export const saveState = async (path: string, state: DaemonState): Promise<void> => {
  const temporaryPath = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf-8")
  await rename(temporaryPath, path)
}

/** With no prior state the daemon starts from "now" rather than replaying the whole bucket as notifications. */
export const seedMark = (now: Date): string => now.toISOString()

const toLoadResult = (path: string, text: string): LoadStateResult =>
  Either.match(decodeStateJson(text), {
    onLeft: (message): LoadStateResult => ({ _tag: "LoadStateFailure", message: `State file "${path}" is unusable: ${message}` }),
    onRight: (state): LoadStateResult => ({ _tag: "LoadedState", state })
  })

const decodeStateJson = (text: string): Either.Either<DaemonState, string> =>
  Either.flatMap(parseJson(text), value => Either.mapLeft(decodeState(value), error => ParseResult.TreeFormatter.formatErrorSync(error)))

const parseJson = (text: string): Either.Either<unknown, string> =>
  Either.try({ try: (): unknown => JSON.parse(text), catch: cause => `not valid JSON (${describeCause(cause)})` })

const isNotFound = (cause: unknown): boolean => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

const failure = (path: string, cause: unknown): LoadStateFailure => ({
  _tag: "LoadStateFailure",
  message: `Could not read state file "${path}": ${describeCause(cause)}`
})

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const decodeState = /*#__PURE__*/ Schema.decodeUnknownEither(StateSchema, { errors: "all" })
