/**
 * RFC 9421 HTTP Message Signatures — sign outgoing requests with the
 * standard `Signature-Input` + `Signature` headers.
 *
 * Cloudflare's Verified Bots program and the OpenAI Operator use 9421
 * for cryptographic request authentication. The algorithm:
 *
 *   1. Build the signature base from the chosen components (derived
 *      pseudo-headers like `@method`, `@target-uri`, plus regular
 *      headers).
 *   2. Append a `@signature-params` line carrying the components
 *      list, optional `keyid`, `alg`, `created`, `expires`, `nonce`,
 *      `tag` parameters.
 *   3. Sign the base with `crypto.subtle.sign` and emit the headers:
 *      `Signature-Input: <label>=<params>` and
 *      `Signature: <label>=:<base64>:`.
 *
 * Web Crypto only — no peer dep. Supported algorithms map directly to
 * `subtle.sign`:
 *   - `ed25519`            — `Ed25519`
 *   - `ecdsa-p256-sha256`  — `ECDSA` over P-256 with SHA-256
 *   - `rsa-pss-sha512`     — `RSA-PSS` with SHA-512 + 64-byte salt
 *   - `hmac-sha256`        — `HMAC` with SHA-256 (shared secret)
 *
 * @example
 * ```ts
 * import { createMisina } from "misina"
 * import { messageSignature } from "misina/auth/signed"
 *
 * const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
 * const api = createMisina({
 *   baseURL,
 *   use: [
 *     messageSignature({
 *       keyId: "my-key",
 *       privateKey: keyPair.privateKey,
 *       algorithm: "ed25519",
 *       components: ["@method", "@target-uri", "content-type", "content-digest"],
 *     }),
 *   ],
 * })
 * ```
 */

import type { MisinaPlugin } from "../types.ts"

export type MessageSignatureAlgorithm =
  | "ed25519"
  | "ecdsa-p256-sha256"
  | "rsa-pss-sha512"
  | "hmac-sha256"

export interface MessageSignatureOptions {
  /** Key identifier; emitted as `keyid` in Signature-Input. */
  keyId?: string
  /** Algorithm identifier; emitted as `alg` in Signature-Input. */
  algorithm: MessageSignatureAlgorithm
  /**
   * Signing key. `CryptoKey` for asymmetric algos (`ed25519`,
   * `ecdsa-p256-sha256`, `rsa-pss-sha512`); raw `Uint8Array` or
   * `CryptoKey` for `hmac-sha256`.
   */
  privateKey: CryptoKey | Uint8Array
  /**
   * Components to cover. Pseudo-headers start with `@` (RFC 9421 §2.2).
   * Regular header names match canonical lowercase. Default:
   * `["@method", "@target-uri", "content-type", "content-digest"]`.
   */
  components?: readonly string[]
  /** Label used in `Signature-Input` and `Signature`. Default: `"sig1"`. */
  label?: string
  /**
   * Optional `created` parameter. Default: `Math.floor(Date.now()/1000)`.
   * Pass `false` to omit (rare).
   */
  created?: number | false
  /** Optional `expires` parameter (Unix seconds). */
  expires?: number
  /** Optional `nonce` parameter — opaque per-message nonce. */
  nonce?: string
  /** Optional `tag` parameter — application-defined string. */
  tag?: string
}

const DEFAULT_COMPONENTS: readonly string[] = [
  "@method",
  "@target-uri",
  "content-type",
  "content-digest",
]

/**
 * Sign every outgoing request per RFC 9421. The hook builds the signature
 * base, signs it with the caller's key, and writes `Signature-Input` +
 * `Signature` to the request headers.
 */
export function messageSignature(options: MessageSignatureOptions): MisinaPlugin {
  return {
    name: "messageSignature",
    hooks: {
      beforeRequest: async (ctx) => signRequest(ctx.request, options),
    },
  }
}

/**
 * Sign a single Request and return a new Request with `Signature-Input`
 * and `Signature` attached. Pure — no instance / hook required.
 */
export async function signRequest(
  request: Request,
  options: MessageSignatureOptions,
): Promise<Request> {
  const components = options.components ?? DEFAULT_COMPONENTS
  const label = options.label ?? "sig1"
  const created =
    options.created === false ? undefined : (options.created ?? Math.floor(Date.now() / 1000))

  const componentsList = `(${components.map((c) => `"${c}"`).join(" ")})`
  const params: string[] = [componentsList]
  if (created !== undefined) params.push(`created=${created}`)
  if (options.expires !== undefined) params.push(`expires=${options.expires}`)
  if (options.keyId) params.push(`keyid="${options.keyId}"`)
  if (options.algorithm) params.push(`alg="${options.algorithm}"`)
  if (options.nonce) params.push(`nonce="${options.nonce}"`)
  if (options.tag) params.push(`tag="${options.tag}"`)
  const sigParamsValue = params.join(";")

  const baseLines: string[] = []
  for (const c of components) {
    const value = await componentValue(c, request)
    if (value === undefined) {
      throw new Error(`misina/auth/signed: missing component ${c}`)
    }
    baseLines.push(`"${c}": ${value}`)
  }
  baseLines.push(`"@signature-params": ${sigParamsValue}`)
  const signatureBase = baseLines.join("\n")

  const signature = await sign(
    new TextEncoder().encode(signatureBase),
    options.algorithm,
    options.privateKey,
  )
  const signatureB64 = bytesToBase64(new Uint8Array(signature))

  const headers = new Headers(request.headers)
  // RFC 9421 §4.2: Signature-Input is a Dictionary keyed by label.
  headers.set("signature-input", `${label}=${sigParamsValue}`)
  headers.set("signature", `${label}=:${signatureB64}:`)

  return new Request(request, { headers })
}

/* ----------------------------------------------------------------------- */
/*                          component derivation                            */
/* ----------------------------------------------------------------------- */

async function componentValue(name: string, request: Request): Promise<string | undefined> {
  // Derived components (pseudo-headers, RFC 9421 §2.2).
  if (name.startsWith("@")) {
    const url = new URL(request.url)
    switch (name) {
      case "@method":
        return request.method.toUpperCase()
      case "@target-uri":
        return request.url
      case "@authority":
        return url.host
      case "@scheme":
        return url.protocol.replace(":", "")
      case "@request-target":
        // Concrete request-target (path?query) used in older drafts.
        return url.pathname + (url.search || "")
      case "@path":
        return url.pathname
      case "@query":
        return url.search
      default:
        return undefined
    }
  }
  // Regular headers — canonical value with leading/trailing whitespace
  // trimmed and internal runs collapsed (RFC 9421 §2.1).
  const value = request.headers.get(name)
  if (value === null) return undefined
  return value.trim().replace(/\s+/g, " ")
}

/* ----------------------------------------------------------------------- */
/*                              signing                                     */
/* ----------------------------------------------------------------------- */

async function sign(
  data: Uint8Array,
  algorithm: MessageSignatureAlgorithm,
  key: CryptoKey | Uint8Array,
): Promise<ArrayBuffer> {
  const subtle = (globalThis as typeof globalThis & { crypto: Crypto }).crypto.subtle
  if (algorithm === "hmac-sha256") {
    const cryptoKey =
      key instanceof Uint8Array
        ? await subtle.importKey(
            "raw",
            key as BufferSource,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          )
        : key
    return subtle.sign("HMAC", cryptoKey, data as BufferSource)
  }
  if (!(key instanceof CryptoKey)) {
    throw new Error(
      `misina/auth/signed: ${algorithm} requires a CryptoKey privateKey, got Uint8Array`,
    )
  }
  switch (algorithm) {
    case "ed25519":
      return subtle.sign("Ed25519", key, data as BufferSource)
    case "ecdsa-p256-sha256":
      return subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource)
    case "rsa-pss-sha512":
      return subtle.sign({ name: "RSA-PSS", saltLength: 64 }, key, data as BufferSource)
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
