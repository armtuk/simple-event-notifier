import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { describeCause } from "@personal-events/event-model"

/**
 * Client construction and the start-up bucket probe required by `.agents/guidance/aws.md` § S3
 * § "Usage in Code": *whenever an S3 bucket is used in code, a pre-flight check should be performed
 * to ensure the bucket exists at the time the service which uses that bucket starts up.* Without it
 * a typo'd bucket name produces a process that looks healthy and silently writes nothing.
 *
 * The three-way result matters as much as the probe. A 404/403/301 is evidence the configuration is
 * **wrong**; a DNS failure or a 5xx is evidence of nothing at all, and a long-running producer
 * started before its network is up must retry rather than exit. Collapsing the two would turn a
 * flaky wifi association into a dead service.
 *
 * > **Known duplication.** `apps/desktop-notifier/src/s3-client.ts` predates this package and
 * > carries a near-identical probe. Collapsing it into this shared module is recorded as a
 * > follow-up in `.agents/plans/github-integration/feature.md`; it was not done here because it
 * > would move a Level 0 app's specs mid-feature.
 */

export interface BucketReachable {
  readonly _tag: "BucketReachable"
}

/** Definitively wrong: no such bucket here, or these credentials may not use it. */
export interface BucketUnreachable {
  readonly _tag: "BucketUnreachable"
  readonly message: string
}

/** The probe could not find out — DNS, TLS, a dropped link, a 5xx. Not evidence the bucket is missing. */
export interface BucketProbeInconclusive {
  readonly _tag: "BucketProbeInconclusive"
  readonly message: string
}

export type BucketProbeResult = BucketReachable | BucketUnreachable | BucketProbeInconclusive

export const createS3Client = (region: string): S3Client => new S3Client({ region, credentials: fromNodeProviderChain() })

export const probeEventBucket = async (client: S3Client, bucket: string): Promise<BucketProbeResult> =>
  client
    .send(new HeadBucketCommand({ Bucket: bucket }))
    .then((): BucketProbeResult => ({ _tag: "BucketReachable" }))
    .catch((cause: unknown): BucketProbeResult => toProbeFailure(cause))

const toProbeFailure = (cause: unknown): BucketProbeResult => {
  const status = httpStatusOf(cause)
  return status !== undefined && status < 500 && bucketFailuresByStatus[status] !== undefined
    ? { _tag: "BucketUnreachable", message: describeBucketFailure(cause) }
    : { _tag: "BucketProbeInconclusive", message: describeBucketFailure(cause) }
}

/**
 * `HeadBucket` answers with a bodyless 404/403, so the SDK surfaces a bare `UnknownError` — useless
 * to an operator reading one log line. Translate the status into the thing that is actually wrong.
 */
export const describeBucketFailure = (cause: unknown): string => {
  const status = httpStatusOf(cause)
  return status === undefined ? describeCause(cause) : (bucketFailuresByStatus[status] ?? `HTTP ${status}: ${describeCause(cause)}`)
}

const bucketFailuresByStatus: Partial<Record<number, string>> = {
  404: "no such bucket in this region — check the bucket name and the region",
  403: "access denied — the credentials in use are not allowed to write this bucket",
  301: "the bucket exists but lives in a different region — check the region"
}

const httpStatusOf = (cause: unknown): number | undefined =>
  typeof cause === "object" && cause !== null && "$metadata" in cause ? statusFromMetadata(cause.$metadata) : undefined

const statusFromMetadata = (metadata: unknown): number | undefined =>
  typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined
