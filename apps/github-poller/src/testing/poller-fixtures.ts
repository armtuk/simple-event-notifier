import { Writable } from "node:stream"
import type { S3Client } from "@aws-sdk/client-s3"
import { asEventBucketName, asStateBucketName, S3EventRepository } from "@personal-events/event-sink"
import { loadGithubConfig } from "@personal-events/github"
import { Either } from "effect"
import { format, type Logger, transports } from "winston"
import { createPollerLogger } from "../logger.ts"
import { emptyPollerState, type PollerState } from "../poller-state.ts"
import { PollerStateRepository } from "../poller-state-repository.ts"

/**
 * Fixtures for the poller. `fetch` and the S3 `send` boundary are the only fakes; every decision
 * under test — conditional headers, status handling, dedupe, cursor advancement, notBefore — runs the
 * real code. `.agents/tests.md` prefers real APIs, and the deploy-gated rows in the story cover that
 * half; what a unit spec can settle is behaviour against *specific* responses, including the
 * rate-limit and malformed cases a live API will not produce on demand.
 */

export const eventBucket = asEventBucketName("events.prod.personal-events.fifthdimensionengineering.com")

export const stateBucket = asStateBucketName("state.prod.personal-events.fifthdimensionengineering.com")

export const stateKey = "state/github-poller.json"

export const compiledGithubConfig = Either.getOrThrow(loadGithubConfig())

export interface CapturedLog {
  readonly level: string
  readonly message: string
  readonly [key: string]: unknown
}

export interface CapturingLogger {
  readonly logger: Logger
  readonly captured: CapturedLog[]
}

export const capturingLogger = (): CapturingLogger => {
  const captured: CapturedLog[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done): void {
      captured.push(
        ...String(chunk)
          .split("\n")
          .filter(line => line.trim().length > 0)
          .map(line => JSON.parse(line) as CapturedLog)
      )
      done()
    }
  })
  const logger = createPollerLogger({ level: "debug", env: "development" })
  logger.clear()
  logger.add(new transports.Stream({ stream, format: format.json(), level: "debug" }))
  return { logger, captured }
}

export const entriesFor = (captured: readonly CapturedLog[], message: string): CapturedLog[] =>
  captured.filter(entry => entry.message === message)

export interface RecordedCommand {
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface FakeS3 {
  readonly client: S3Client
  readonly commands: RecordedCommand[]
  readonly stored: Map<string, string>
}

export interface FakeS3Options {
  readonly initialState?: PollerState | string
  readonly failEventWrite?: unknown
  readonly failStateRead?: unknown
}

/** An in-memory S3 that actually round-trips the state object, so "does a restart resume?" is real. */
export const fakeS3 = (options: FakeS3Options = {}): FakeS3 => {
  const commands: RecordedCommand[] = []
  const stored = new Map<string, string>()
  if (options.initialState !== undefined) {
    stored.set(stateKey, typeof options.initialState === "string" ? options.initialState : JSON.stringify(options.initialState))
  }
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      commands.push({ name: command.constructor.name, input: command.input })
      return respond(command, stored, options)
    }
  }
  return { client: client as unknown as S3Client, commands, stored }
}

const respond = async (
  command: { constructor: { name: string }; input: Record<string, unknown> },
  stored: Map<string, string>,
  options: FakeS3Options
): Promise<unknown> => {
  const key = String(command.input.Key)
  if (command.constructor.name === "GetObjectCommand") {
    return options.failStateRead !== undefined
      ? Promise.reject(options.failStateRead)
      : stored.has(key)
        ? { Body: { transformToString: async (): Promise<string> => stored.get(key) ?? "" } }
        : Promise.reject(noSuchKey())
  }
  if (command.input.Bucket === eventBucket && options.failEventWrite !== undefined) {
    return Promise.reject(options.failEventWrite)
  }
  stored.set(key, String(command.input.Body))
  return {}
}

export const noSuchKey = (): Error => Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })

export const eventRepositoryOver = (s3: FakeS3): S3EventRepository => new S3EventRepository(s3.client, eventBucket)

export const stateRepositoryOver = (s3: FakeS3, logger: Logger, key: string = stateKey): PollerStateRepository =>
  new PollerStateRepository(s3.client, stateBucket, key, logger)

export const commandsNamed = (commands: readonly RecordedCommand[], name: string): RecordedCommand[] =>
  commands.filter(command => command.name === name)

export const eventPuts = (s3: FakeS3): RecordedCommand[] =>
  commandsNamed(s3.commands, "PutObjectCommand").filter(command => command.input.Bucket === eventBucket)

/**
 * The **distinct object keys** that survive in the fake bucket, as opposed to the number of writes
 * attempted. The two differ exactly when two events collapse onto one key and the second silently
 * overwrites the first — a loss that counting `PutObjectCommand`s cannot see, because both puts
 * genuinely happen and both genuinely succeed.
 */
export const storedEventKeys = (s3: FakeS3): readonly string[] => [...s3.stored.keys()].filter(key => key !== stateKey)

export { emptyPollerState }

/** A `fetch` stand-in returning scripted responses in order, recording what was asked for. */
export interface FakeFetch {
  readonly fetch: typeof globalThis.fetch
  readonly requests: { readonly url: string; readonly headers: Record<string, string> }[]
}

export interface ScriptedResponse {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
}

export const fakeFetch = (script: readonly ScriptedResponse[]): FakeFetch => {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const respondWith = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const index = requests.length
    requests.push({ url: String(input), headers: toHeaderRecord(init?.headers) })
    const scripted = script[Math.min(index, script.length - 1)] ?? { status: 500 }
    return new Response(scripted.body === undefined ? null : JSON.stringify(scripted.body), {
      status: scripted.status,
      headers: scripted.headers ?? {}
    })
  }
  return { fetch: respondWith as typeof globalThis.fetch, requests }
}

const toHeaderRecord = (headers: RequestInit["headers"]): Record<string, string> =>
  headers === undefined ? {} : Object.fromEntries(Object.entries(headers as Record<string, string>))

export const withFetch = async <T>(fake: FakeFetch, body: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return body().finally(() => {
    globalThis.fetch = original
  })
}

/** An in-memory SSM: maps parameter names to values, or rejects a named parameter to exercise a read failure. */
export interface FakeSsm {
  readonly client: import("@aws-sdk/client-ssm").SSMClient
  readonly reads: string[]
}

export interface FakeSsmOptions {
  readonly values?: Readonly<Record<string, string>>
  readonly failParams?: readonly string[]
}

export const fakeSsm = (options: FakeSsmOptions = {}): FakeSsm => {
  const reads: string[] = []
  const client = {
    send: async (command: { input: { Name?: string } }): Promise<unknown> => {
      const name = command.input.Name ?? ""
      reads.push(name)
      if ((options.failParams ?? []).includes(name)) {
        return Promise.reject(Object.assign(new Error("access denied"), { name: "AccessDeniedException" }))
      }
      const value = options.values?.[name]
      return value === undefined ? { Parameter: undefined } : { Parameter: { Value: value } }
    }
  }
  return { client: client as unknown as import("@aws-sdk/client-ssm").SSMClient, reads }
}
