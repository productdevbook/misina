/**
 * OAuth 2.1 / PKCE helpers and JWT-aware refresh.
 *
 * `withJwtRefresh(misina, opts)` peeks the JWT exp claim on every request
 * and proactively refreshes the token *before* a 401 round-trip. Concurrent
 * requests with an expired token collapse onto a single refresh call.
 *
 * `createPkcePair()` generates a code verifier + S256 challenge per RFC
 * 7636 §4.1–4.2; `exchangePkceCode(...)` performs the standard token
 * exchange (RFC 6749 §4.1.3) with the verifier attached.
 */

import type { Misina, MisinaContext } from "../types.ts"

/* ----------------------------------------------------------------------- */
/*                            withJwtRefresh                                */
/* ----------------------------------------------------------------------- */

export interface JwtRefreshOptions {
  /** Async function that returns a new token. Concurrent calls collapse. */
  refresh: () => string | Promise<string>
  /** Read the current token (so we can decode it and decide). */
  getToken: () => string | undefined | Promise<string | undefined>
  /**
   * Refresh this many milliseconds before the JWT's `exp` claim. Lets
   * the call site tolerate clock skew and a slow network. Default:
   * 30_000 (30 s).
   */
  expiryWindowMs?: number
  /**
   * Reject when refresh returns the same token (likely a misconfigured
   * IdP). Default: true.
   */
  rejectIfUnchanged?: boolean
  /**
   * Override the predicate for "this request needs auth at all". Default:
   * any request whose Authorization header is set.
   */
  shouldRefresh?: (ctx: MisinaContext) => boolean
}

/**
 * Peek the JWT in the current `Authorization: Bearer <token>` header and
 * preemptively refresh it when it would expire within `expiryWindowMs`.
 * Concurrent expired requests share one refresh (mutex).
 *
 * Refresh runs in `beforeRequest`, so the *current* request goes out with
 * the new token — no extra 401 round-trip.
 */
export function withJwtRefresh(misina: Misina, opts: JwtRefreshOptions): Misina {
  const window = opts.expiryWindowMs ?? 30_000
  const rejectIfUnchanged = opts.rejectIfUnchanged ?? true
  let inflight: Promise<string> | undefined

  async function refreshOnce(current: string | undefined): Promise<string> {
    if (!inflight) {
      inflight = Promise.resolve(opts.refresh())
        .then((next) => {
          if (rejectIfUnchanged && current && next === current) {
            throw new Error("withJwtRefresh: refresh returned the same token")
          }
          return next
        })
        .finally(() => {
          queueMicrotask(() => {
            inflight = undefined
          })
        })
    }
    return inflight
  }

  return misina.extend({
    hooks: {
      beforeRequest: async (ctx) => {
        if (opts.shouldRefresh && !opts.shouldRefresh(ctx)) return
        const token = await opts.getToken()
        if (!token) return
        const exp = peekJwtExp(token)
        if (exp === null) return // not a JWT, nothing to do
        const msUntilExpiry = exp * 1000 - Date.now()
        if (msUntilExpiry > window) return // still fresh

        const next = await refreshOnce(token)
        const headers = new Headers(ctx.request.headers)
        headers.set("authorization", `Bearer ${next}`)
        return new Request(ctx.request, { headers })
      },
    },
  })
}

/**
 * Decode the `exp` claim from a JWT without verifying its signature. The
 * server is the only entity that can verify; the client uses this purely
 * to decide when to refresh. Returns null if the input doesn't look like
 * a JWT, the payload isn't JSON, or `exp` is missing.
 */
export function peekJwtExp(token: string): number | null {
  const parts = token.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = base64UrlDecode(parts[1])
    const payload = JSON.parse(json) as { exp?: unknown }
    return typeof payload.exp === "number" ? payload.exp : null
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------------- */
/*                              PKCE primitives                              */
/* ----------------------------------------------------------------------- */

export interface PkcePair {
  /** Random URL-safe verifier (RFC 7636 §4.1). 43–128 chars. */
  verifier: string
  /** Base64URL(SHA-256(verifier)), per S256 method (RFC 7636 §4.2). */
  challenge: string
  /** Always `'S256'` — we don't ship plain method (RFC 8252 §8.1). */
  method: "S256"
}

/**
 * Generate a fresh PKCE verifier + S256 challenge pair. The verifier is
 * 32 bytes of crypto-grade randomness, base64url-encoded (43 chars), and
 * the challenge is base64url(SHA-256(verifier)).
 *
 * Caller stores the verifier (server-side session, sessionStorage, or an
 * encrypted cookie) until the redirect comes back, then attaches it to
 * the token exchange call via `exchangePkceCode`.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const subtle = (globalThis as typeof globalThis & { crypto: Crypto }).crypto.subtle
  const random = new Uint8Array(32)
  ;(globalThis as typeof globalThis & { crypto: Crypto }).crypto.getRandomValues(random)
  const verifier = base64UrlEncode(random)
  const challengeBytes = await subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(new Uint8Array(challengeBytes))
  return { verifier, challenge, method: "S256" }
}

export interface PkceExchangeOptions {
  /** RFC 6749 token endpoint URL. */
  tokenEndpoint: string
  /** OAuth client id. */
  clientId: string
  /** Redirect URI used in the original authorization request. */
  redirectUri: string
  /** Authorization code returned by the IdP. */
  code: string
  /** Verifier from the original `createPkcePair()` call. */
  verifier: string
  /** Optional client secret for confidential clients. */
  clientSecret?: string
}

export interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  id_token?: string
  [key: string]: unknown
}

/**
 * Exchange an authorization code for tokens (RFC 6749 §4.1.3) with the
 * PKCE verifier attached (RFC 7636 §4.5). Posts
 * `application/x-www-form-urlencoded` to `tokenEndpoint` and returns
 * the parsed token response.
 */
export async function exchangePkceCode(
  misina: Misina,
  options: PkceExchangeOptions,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_verifier: options.verifier,
  })
  if (options.clientSecret) body.set("client_secret", options.clientSecret)
  const res = await misina.post<OAuthTokenResponse>(options.tokenEndpoint, body, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })
  return res.data
}

/* ----------------------------------------------------------------------- */
/*                                helpers                                   */
/* ----------------------------------------------------------------------- */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(input: string): string {
  let s = input.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4) s += "="
  // atob -> binary string -> assume UTF-8 JSON
  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
