import type { MisinaDriver, MisinaDriverFactory } from "../types.ts"

/**
 * Define a driver factory. Drivers must return a `Response` from `request()`
 * to keep the Web Fetch API shape canonical across all transports.
 *
 * ```ts
 * export default defineDriver(() => ({
 *   name: "fetch",
 *   request: (req) => fetch(req),
 * }))
 * ```
 */
export function defineDriver<TOptions = void>(
  factory: TOptions extends void ? () => MisinaDriver : (options: TOptions) => MisinaDriver,
): MisinaDriverFactory<TOptions> {
  return factory as MisinaDriverFactory<TOptions>
}
