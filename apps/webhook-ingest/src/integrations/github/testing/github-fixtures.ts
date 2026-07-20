import { sign } from "@octokit/webhooks-methods"
import { S3EventRepository } from "@personal-events/event-sink"
import { loadGithubConfig } from "@personal-events/github"
import { readGithubExemplar } from "@personal-events/github/testing"
import { Either } from "effect"
import type { RawRequest } from "../../../raw-request.ts"
import { DeliveryDedupeRepository } from "../delivery-dedupe-repository.ts"
import { githubWebhookHeaders } from "../github-integration.ts"
import { WebhookSecretRepository } from "../webhook-secret-repository.ts"

/**
 * Fixtures for the GitHub edge. The **signature is real** — computed with `@octokit/webhooks-methods`
 * `sign`, verified with the same package's `verify`, over the exact bytes the request carries. No
 * crypto is mocked, because the property under test *is* that a genuine HMAC passes and a forged one
 * does not; a stubbed verifier would assert nothing about that.
 *
 * Only the AWS clients are faked, and only at the `send` boundary, so the real `PutObjectCommand`
 * and `HeadObjectCommand` inputs are what the specs assert against.
 */

export const testSecret = "a-shared-webhook-secret"

export const stateBucket = "state.prod.personal-events.fifthdimensionengineering.com"

export const eventBucket = "events.prod.personal-events.fifthdimensionengineering.com"

export const deliveryPrefix = "deliveries/github"

export const compiledGithubConfig = Either.getOrThrow(loadGithubConfig())

export const exemplarBody = (fileName: string): string => JSON.stringify(readGithubExemplar(fileName))

export const signedRequest = async (options: {
  readonly body: string
  readonly eventName: string
  readonly deliveryId?: string
  readonly secret?: string
}): Promise<RawRequest> => ({
  path: "github",
  rawBody: options.body,
  headers: {
    [githubWebhookHeaders.signature]: await sign(options.secret ?? testSecret, options.body),
    [githubWebhookHeaders.event]: options.eventName,
    ...(options.deliveryId === undefined ? {} : { [githubWebhookHeaders.delivery]: options.deliveryId })
  }
})

export const unsignedRequest = (options: {
  readonly body: string
  readonly eventName: string
  readonly deliveryId?: string
  readonly signature?: string
}): RawRequest => ({
  path: "github",
  rawBody: options.body,
  headers: {
    ...(options.signature === undefined ? {} : { [githubWebhookHeaders.signature]: options.signature }),
    [githubWebhookHeaders.event]: options.eventName,
    ...(options.deliveryId === undefined ? {} : { [githubWebhookHeaders.delivery]: options.deliveryId })
  }
})

export interface RecordedCommand {
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface FakeAws {
  readonly commands: RecordedCommand[]
  readonly events: S3EventRepository
  readonly dedupe: DeliveryDedupeRepository
  readonly secrets: WebhookSecretRepository
}

export interface FakeAwsOptions {
  /** Delivery ids the dedupe store already holds, so `HeadObject` resolves instead of 404ing. */
  readonly alreadySeen?: readonly string[]
  readonly failEventWrite?: unknown
  readonly failDedupeHead?: unknown
  readonly failSecretRead?: unknown
  readonly secret?: string
}

export const fakeAws = (options: FakeAwsOptions = {}): FakeAws => {
  const commands: RecordedCommand[] = []
  const seen = new Set(options.alreadySeen ?? [])

  const s3 = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      commands.push({ name: command.constructor.name, input: command.input })
      return respondToS3(command, seen, options)
    }
  }
  const ssm = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      commands.push({ name: command.constructor.name, input: command.input })
      return options.failSecretRead === undefined
        ? { Parameter: { Value: options.secret ?? testSecret } }
        : Promise.reject(options.failSecretRead)
    }
  }

  return {
    commands,
    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for an SDK client at the `send` boundary only.
    events: new S3EventRepository(s3 as any, eventBucket),
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    dedupe: new DeliveryDedupeRepository(s3 as any, stateBucket, deliveryPrefix),
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    secrets: new WebhookSecretRepository(ssm as any, "/personal-events/github/webhook-secret")
  }
}

const respondToS3 = async (
  command: { constructor: { name: string }; input: Record<string, unknown> },
  seen: Set<string>,
  options: FakeAwsOptions
): Promise<unknown> => {
  const isEventWrite = command.input.Bucket === eventBucket
  if (command.constructor.name === "HeadObjectCommand") {
    return options.failDedupeHead !== undefined
      ? Promise.reject(options.failDedupeHead)
      : seen.has(deliveryIdOf(String(command.input.Key)))
        ? {}
        : Promise.reject(notFoundError())
  }
  return isEventWrite && options.failEventWrite !== undefined ? Promise.reject(options.failEventWrite) : {}
}

const deliveryIdOf = (key: string): string => key.slice(`${deliveryPrefix}/`.length)

export const notFoundError = (): Error => Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })

export const commandsNamed = (commands: readonly RecordedCommand[], name: string): RecordedCommand[] =>
  commands.filter(command => command.name === name)
