import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { describeCause } from "@personal-events/event-model"

/**
 * Gather (setup): the S3 client, plus the two eager pre-flight probes that make a misconfigured
 * machine fail at startup with one clear line instead of at the first poll with an SDK stack trace.
 *
 * The bucket probe is required by `.agents/guidance/aws.md` § S3 § Usage in Code: *"Whenever an S3
 * bucket is used in code, a pre-flight check should be performed to ensure the bucket exists at the
 * time the service which uses that bucket starts up."* Without it a typo'd `EVENT_BUCKET` produces a
 * process that looks healthy — it starts, backs off to the ceiling, and notifies nobody forever.
 */

export interface CredentialsAvailable {
  readonly _tag: "CredentialsAvailable"
}

export interface CredentialsUnavailable {
  readonly _tag: "CredentialsUnavailable"
  readonly message: string
}

export type CredentialProbeResult = CredentialsAvailable | CredentialsUnavailable

export const createS3Client = (region: string): S3Client => new S3Client({ region, credentials: fromNodeProviderChain() })

export interface BucketReachable {
  readonly _tag: "BucketReachable"
}

export interface BucketUnreachable {
  readonly _tag: "BucketUnreachable"
  readonly message: string
}

export type BucketProbeResult = BucketReachable | BucketUnreachable

export const probeCredentials = async (s3: S3Client): Promise<CredentialProbeResult> => {
  const resolve = s3.config.credentials
  return resolve()
    .then((): CredentialProbeResult => ({ _tag: "CredentialsAvailable" }))
    .catch((cause: unknown): CredentialProbeResult => ({ _tag: "CredentialsUnavailable", message: describeCause(cause) }))
}

export const probeBucket = async (s3: S3Client, bucket: string): Promise<BucketProbeResult> =>
  s3
    .send(new HeadBucketCommand({ Bucket: bucket }))
    .then((): BucketProbeResult => ({ _tag: "BucketReachable" }))
    .catch((cause: unknown): BucketProbeResult => ({ _tag: "BucketUnreachable", message: describeBucketFailure(cause) }))

/**
 * `HeadBucket` answers with a bodyless 404/403, so the SDK surfaces a bare `UnknownError` — useless
 * to an operator staring at a log line. Translate the status into the two things that are actually
 * wrong, and only fall back to the generic rendering for anything else (network, DNS, region).
 */
export const describeBucketFailure = (cause: unknown): string => {
  const status = httpStatusOf(cause)
  return status === undefined ? describeCause(cause) : (bucketFailuresByStatus[status] ?? `HTTP ${status}: ${describeCause(cause)}`)
}

const bucketFailuresByStatus: Partial<Record<number, string>> = {
  404: "no such bucket in this region — check EVENT_BUCKET and AWS_REGION",
  403: "access denied — the credentials in use are not allowed to read this bucket",
  301: "the bucket exists but lives in a different region — check AWS_REGION"
}

const httpStatusOf = (cause: unknown): number | undefined =>
  typeof cause === "object" && cause !== null && "$metadata" in cause ? statusFromMetadata(cause.$metadata) : undefined

const statusFromMetadata = (metadata: unknown): number | undefined =>
  typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined
