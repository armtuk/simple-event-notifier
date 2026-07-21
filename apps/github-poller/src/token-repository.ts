import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm"
import { describeCause } from "@personal-events/event-model"
import { Either } from "effect"

/**
 * Reads a GitHub PAT from SSM Parameter Store at invocation time, the same way the webhook handler
 * reads its HMAC secret (`apps/webhook-ingest/.../webhook-secret-repository.ts`) — so both secrets
 * live in one place, and neither is baked into a Lambda environment variable or Terraform state.
 *
 * No memoization here, unlike the webhook path: this is a scheduled Lambda that reads its whole state
 * fresh every invocation, so reading the token fresh too keeps a rotated PAT picked up on the next
 * tick rather than on the next cold start.
 *
 * Returns an `Either` rather than throwing, because a token that cannot be read must disable **its
 * own** source and leave the other running — the entire point of the two-source design. A throw here
 * would take down both.
 */

export class GithubTokenRepository {
  constructor(public ssm: SSMClient) {}

  read = async (parameterName: string): Promise<Either.Either<string, string>> =>
    this.ssm
      .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
      .then(
        (response): Either.Either<string, string> =>
          response.Parameter?.Value === undefined || response.Parameter.Value.length === 0
            ? Either.left(`SSM parameter "${parameterName}" exists but is empty`)
            : Either.right(response.Parameter.Value)
      )
      .catch(
        (cause: unknown): Either.Either<string, string> =>
          Either.left(`could not read SSM parameter "${parameterName}": ${describeCause(cause)}`)
      )
}
