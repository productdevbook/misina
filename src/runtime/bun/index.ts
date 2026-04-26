/**
 * Bun-specific RequestInit augmentation.
 *
 * Importing this module adds typed `tls`, `verbose`, `proxy`, and `unix`
 * fields to `MisinaOptions` via augmentation of `MisinaRuntimeOptions`.
 * The values are passed through to Bun's `fetch` so the runtime can act
 * on them — TLS overrides, debug tracing, HTTP proxy, and unix-socket
 * routing.
 *
 * @example
 * ```ts
 * import "misina/runtime/bun"
 *
 * await api.get("/upstream", {
 *   tls: { rejectUnauthorized: false },
 *   proxy: "http://corp:3128",
 * })
 * ```
 *
 * Reference: https://bun.com/docs/api/fetch
 */

export interface BunTlsOptions {
  /** Reject self-signed / unknown CA certs. Default Bun behavior: true. */
  rejectUnauthorized?: boolean
  /** PEM-encoded CA bundle to trust in addition to the system store. */
  ca?: string | Uint8Array | Array<string | Uint8Array>
  /** PEM-encoded client cert (for mTLS). */
  cert?: string | Uint8Array
  /** PEM-encoded client key. */
  key?: string | Uint8Array
  /** Passphrase for the client key. */
  passphrase?: string
  /** SNI server name override. */
  serverName?: string
  /** Skip checking certificate against ServerName. */
  checkServerIdentity?: (hostname: string, cert: unknown) => Error | undefined
}

declare module "../../types.ts" {
  interface MisinaRuntimeOptions {
    /**
     * Bun TLS overrides. Forwarded to `fetch` after
     * `import "misina/runtime/bun"`.
     */
    tls?: BunTlsOptions
    /**
     * Route through a unix domain socket. Useful for talking to local
     * services or test fixtures.
     */
    unix?: string
    /**
     * HTTP / HTTPS proxy URL. Bun supports both schemes; the request's
     * scheme decides which is honored.
     */
    proxy?: string
    /**
     * Verbose log of the request/response on Bun's stderr. Useful for
     * debugging cross-runtime parity issues.
     */
    verbose?: boolean
  }
}

// Sentinel — keeps the module from being tree-shaken by bundlers when
// imported purely for its side effect (the augmentation above).
export const BUN_RUNTIME_AUGMENTED = true
