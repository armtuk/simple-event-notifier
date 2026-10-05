import { readFile } from "node:fs/promises"
import { describeCause } from "@personal-events/event-model"
import { Either } from "effect"
import { ConfigParseError } from "./errors.ts"

/**
 * The package's **only** I/O — the Gather touchpoint for a host that keeps its mapping config on
 * disk rather than bundling it. It is deliberately alone in this module so that `loader.ts` stays
 * a pure function over an already-read value: a config that arrives from an import, an env var, or
 * a future config service must take the same validation path as one read from a file.
 */

export const readConfigFile = async (path: string): Promise<Either.Either<unknown, ConfigParseError>> =>
  readFile(path, "utf-8")
    .then(text => parseJson(text, path))
    .catch((cause: unknown) =>
      Either.left(
        new ConfigParseError({ integration: "unknown", reason: `could not read mapping config "${path}": ${describeCause(cause)}` })
      )
    )

const parseJson = (text: string, path: string): Either.Either<unknown, ConfigParseError> =>
  Either.try({
    try: (): unknown => JSON.parse(text),
    catch: cause =>
      new ConfigParseError({ integration: "unknown", reason: `mapping config "${path}" is not valid JSON: ${describeCause(cause)}` })
  })
