import { S3Client } from "@aws-sdk/client-s3"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"

/**
 * Gather (setup): the S3 client, plus an eager credential probe so a misconfigured machine fails
 * at startup with one clear line rather than at the first poll with an SDK stack trace.
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

export const probeCredentials = async (s3: S3Client): Promise<CredentialProbeResult> => {
  const resolve = s3.config.credentials
  return resolve()
    .then((): CredentialProbeResult => ({ _tag: "CredentialsAvailable" }))
    .catch((cause: unknown): CredentialProbeResult => ({ _tag: "CredentialsUnavailable", message: describeCause(cause) }))
}

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
