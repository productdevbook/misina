import type { MisinaDriver, MisinaDriverFactory } from "../types.ts"
import { defineDriver } from "./_define.ts"

export interface FetchDriverOptions {
  fetch?: typeof globalThis.fetch
}

const fetchDriver: MisinaDriverFactory<FetchDriverOptions | void> =
  defineDriver<FetchDriverOptions | void>((options) => {
    const fetchImpl = (options as FetchDriverOptions | undefined)?.fetch ?? globalThis.fetch

    if (typeof fetchImpl !== "function") {
      throw new Error(
        "misina/driver/fetch: globalThis.fetch is unavailable. Provide `options.fetch`.",
      )
    }

    return {
      name: "fetch",
      request: (request: Request): Promise<Response> => fetchImpl(request),
    } satisfies MisinaDriver
  })

export default fetchDriver
