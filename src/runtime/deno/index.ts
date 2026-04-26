/**
 * Deno-specific RequestInit augmentation.
 *
 * Importing this module adds a typed `client` field to `MisinaOptions`
 * via augmentation of `MisinaRuntimeOptions`. The value is passed
 * through to Deno's `fetch` so a `Deno.HttpClient` (created via
 * `Deno.createHttpClient(...)`) can route the request — useful for
 * custom CA bundles, mTLS client identities, proxies, and HTTP/2
 * pooling tweaks.
 *
 * @example
 * ```ts
 * import "misina/runtime/deno"
 *
 * const client = Deno.createHttpClient({ caCerts: [pem] })
 * await api.get("/upstream", { client })
 * ```
 *
 * Reference: https://docs.deno.com/api/deno/~/Deno.HttpClient
 */

/**
 * Opaque shape for `Deno.HttpClient`. We don't type the full surface;
 * the user gets the typed handle directly from `Deno.createHttpClient`
 * and just hands it to misina, which forwards it as `init.client`.
 */
export interface DenoHttpClientLike {
  readonly [Symbol.dispose]?: () => void
  close?: () => void
}

declare module "../../types.ts" {
  interface MisinaRuntimeOptions {
    /**
     * Deno-specific HTTP client handle. Forwarded to `fetch` after
     * `import "misina/runtime/deno"`. Create one with
     * `Deno.createHttpClient(...)` and reuse across requests.
     */
    client?: DenoHttpClientLike
  }
}

export const DENO_RUNTIME_AUGMENTED = true
