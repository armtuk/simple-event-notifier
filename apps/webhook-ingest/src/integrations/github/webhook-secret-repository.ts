import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm"
import { describeCause } from "@personal-events/event-model"

/**
 * The one place SSM is touched. The HMAC secret is read **once per cold start** and memoized for the
 * life of the execution environment: a `GetParameter` on every delivery would spend a network
 * round-trip out of GitHub's ~10 s budget for a value that does not change between invocations.
 *
 * The memo caches the **promise**, not the value, so concurrent invocations on one warm environment
 * share a single in-flight read rather than racing to issue their own.
 *
 * A failed read is **not** cached. Caching it would turn one transient SSM blip into a function that
 * answers **500** to every delivery until AWS happens to recycle the warm environment — a
 * `secrets.get()` rejection propagates out of `handle` and the handler maps it to a server error.
 * A 500 is visible in GitHub's delivery log and hand-redeliverable (within the three-day window),
 * with the poller as the backstop — but making a whole warm environment reject deliveries over one
 * transient blip is still the wrong trade, so the memo is cleared on failure and the next delivery
 * retries the read.
 */

export class WebhookSecretRepository {
  cached: Promise<string> | undefined

  constructor(
    public ssm: SSMClient,
    public parameterName: string
  ) {}

  get = async (): Promise<string> => {
    this.cached ??= this.fetch().catch((cause: unknown) => {
      this.cached = undefined
      return Promise.reject(cause)
    })
    return this.cached
  }

  fetch = async (): Promise<string> => {
    const response = await this.ssm
      .send(new GetParameterCommand({ Name: this.parameterName, WithDecryption: true }))
      .catch((cause: unknown) =>
        Promise.reject(new Error(`could not read webhook secret "${this.parameterName}": ${describeCause(cause)}`))
      )
    return response.Parameter?.Value === undefined || response.Parameter.Value.length === 0
      ? Promise.reject(
          new Error(`webhook secret "${this.parameterName}" exists but is empty; set it with aws ssm put-parameter --overwrite`)
        )
      : response.Parameter.Value
  }
}
