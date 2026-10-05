import { Either, type ParseResult, Schema } from "effect"
import {
  GenericWebhookSchema,
  IssuesEventSchema,
  PullRequestEventSchema,
  PullRequestReviewEventSchema,
  PushEventSchema,
  ReleaseEventSchema
} from "./webhook-payloads.ts"

/**
 * The `X-GitHub-Event` name → *how to read that payload* lookup. Selecting behaviour on one
 * discriminator is a `Record` lookup, never a chain of `if`s — and the fallback is a real entry, so
 * an unmodelled event has a defined reading rather than a missing one.
 *
 * Each entry pairs a schema with the extractor for **its own** shape, which is what keeps extraction
 * type-safe: `factsOf` sees the decoded struct, not an `unknown` it has to re-narrow. The pairing is
 * then erased behind `WebhookReader`, so the registry can hold entries of different decoded types in
 * one homogeneous map.
 */

/** Everything the normalizer needs from a payload — deliberately tiny, because everything else rides in `payload`. */
export interface WebhookFacts {
  readonly action: string | undefined
  readonly workItem: string | undefined
  readonly repository: string | undefined
}

export interface WebhookReader {
  readonly read: (raw: unknown) => Either.Either<WebhookFacts, ParseResult.ParseError>
}

const webhookReader = <A, I>(schema: Schema.Schema<A, I>, factsOf: (decoded: A) => WebhookFacts): WebhookReader => {
  const decode = Schema.decodeUnknownEither(schema, { errors: "all" })
  return { read: (raw: unknown): Either.Either<WebhookFacts, ParseResult.ParseError> => Either.map(decode(raw), factsOf) }
}

export const genericWebhookReader = /*#__PURE__*/ webhookReader(GenericWebhookSchema, decoded => ({
  action: decoded.action,
  workItem: undefined,
  repository: decoded.repository?.full_name
}))

export const webhookReaders: Record<string, WebhookReader> = {
  pull_request: /*#__PURE__*/ webhookReader(PullRequestEventSchema, decoded => ({
    action: decoded.action,
    workItem: decoded.pull_request.html_url,
    repository: decoded.repository.full_name
  })),
  pull_request_review: /*#__PURE__*/ webhookReader(PullRequestReviewEventSchema, decoded => ({
    action: decoded.action,
    workItem: decoded.pull_request.html_url,
    repository: decoded.repository.full_name
  })),
  issues: /*#__PURE__*/ webhookReader(IssuesEventSchema, decoded => ({
    action: decoded.action,
    workItem: decoded.issue.html_url,
    repository: decoded.repository.full_name
  })),
  push: /*#__PURE__*/ webhookReader(PushEventSchema, decoded => ({
    action: undefined,
    workItem: decoded.compare,
    repository: decoded.repository.full_name
  })),
  release: /*#__PURE__*/ webhookReader(ReleaseEventSchema, decoded => ({
    action: decoded.action,
    workItem: decoded.release.html_url,
    repository: decoded.repository.full_name
  }))
}

/**
 * `noUncheckedIndexedAccess` makes the miss explicit, and the miss is the ordinary case: GitHub
 * sends dozens of event types and this integration models six. An unmodelled event reads through
 * the permissive generic schema and goes on to be classified by the config default.
 */
export const readerFor = (eventName: string): WebhookReader => webhookReaders[eventName] ?? genericWebhookReader

export const isModelledWebhookEvent = (eventName: string): boolean => webhookReaders[eventName] !== undefined
