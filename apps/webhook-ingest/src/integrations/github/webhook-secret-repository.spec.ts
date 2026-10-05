import type { SSMClient } from "@aws-sdk/client-ssm"
import { describe, expect, it } from "vitest"
import { WebhookSecretRepository } from "./webhook-secret-repository.ts"

const parameterName = "/personal-events/github/webhook-secret"

interface Probe {
  readonly repository: WebhookSecretRepository
  readonly calls: Record<string, unknown>[]
}

const repositoryOver = (respond: (call: number) => Promise<unknown>): Probe => {
  const calls: Record<string, unknown>[] = []
  const ssm = {
    send: async (command: { input: Record<string, unknown> }): Promise<unknown> => {
      calls.push(command.input)
      return respond(calls.length - 1)
    }
  }
  return { repository: new WebhookSecretRepository(ssm as unknown as SSMClient, parameterName), calls }
}

describe("WebhookSecretRepository", () => {
  it("reads the parameter with decryption, because it is stored as a SecureString", async () => {
    const { repository, calls } = repositoryOver(async () => ({ Parameter: { Value: "s3cret" } }))
    expect(await repository.get()).toBe("s3cret")
    expect(calls[0]).toStrictEqual({ Name: parameterName, WithDecryption: true })
  })

  it("reads once and memoizes, so a warm invocation spends no time on SSM", async () => {
    const { repository, calls } = repositoryOver(async () => ({ Parameter: { Value: "s3cret" } }))
    await Promise.all([repository.get(), repository.get(), repository.get()])
    expect(calls).toHaveLength(1)
  })

  it("shares one in-flight read between concurrent invocations rather than racing", async () => {
    const { repository, calls } = repositoryOver(
      async () => new Promise(resolve => setTimeout(() => resolve({ Parameter: { Value: "s" } }), 5))
    )
    const results = await Promise.all([repository.get(), repository.get()])
    expect(results).toStrictEqual(["s", "s"])
    expect(calls).toHaveLength(1)
  })

  it("does NOT cache a failure — one SSM blip must not reject every delivery until the environment recycles", async () => {
    const { repository, calls } = repositoryOver(async call =>
      call === 0 ? Promise.reject(new Error("throttled")) : { Parameter: { Value: "s" } }
    )
    await expect(repository.get()).rejects.toThrow("could not read webhook secret")
    expect(await repository.get()).toBe("s")
    expect(calls).toHaveLength(2)
  })

  it("names the parameter in the failure, so an operator knows which one to check", async () => {
    const { repository } = repositoryOver(async () => Promise.reject(new Error("AccessDenied")))
    await expect(repository.get()).rejects.toThrow(parameterName)
  })

  it("rejects a parameter that exists but is empty, rather than verifying every signature against an empty secret", async () => {
    const { repository } = repositoryOver(async () => ({ Parameter: { Value: "" } }))
    await expect(repository.get()).rejects.toThrow("exists but is empty")
  })

  it("rejects a response with no parameter at all", async () => {
    const { repository } = repositoryOver(async () => ({}))
    await expect(repository.get()).rejects.toThrow("exists but is empty")
  })
})
