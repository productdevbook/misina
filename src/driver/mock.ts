import type { MisinaDriver, MisinaDriverFactory } from "../types.ts"
import { defineDriver } from "./_define.ts"

export interface MockCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

export type MockHandler = (request: Request) => Response | Promise<Response>

export interface MockDriverOptions {
  /** Static response for every request. */
  response?: Response
  /** Function returning a Response per request. */
  handler?: MockHandler
}

export interface MockDriverApi {
  calls: MockCall[]
  reset: () => void
}

const apis = new WeakMap<object, MockDriverApi>()

export function getMockApi(driver: object): MockDriverApi | undefined {
  return apis.get(driver)
}

const mockDriver: MisinaDriverFactory<MockDriverOptions> = defineDriver<MockDriverOptions>(
  (options) => {
    const calls: MockCall[] = []

    const driver: MisinaDriver = {
      name: "mock",
      async request(request: Request): Promise<Response> {
        const body = request.body ? await request.clone().text() : undefined
        calls.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        })

        if (options.handler) return options.handler(request)
        if (options.response) return options.response.clone()
        return new Response(null, { status: 200 })
      },
    }

    apis.set(driver, {
      calls,
      reset: (): void => {
        calls.length = 0
      },
    })

    return driver
  },
)

export default mockDriver
