/**
 * RFC 9530 Digest Fields — `Content-Digest` and `Repr-Digest`.
 *
 * `digestAuth(opts)` automatically computes a digest of the outgoing
 * request body and attaches it as a Structured Field dictionary header.
 * `verifyDigest(response)` reads the digest from a received response and
 * verifies it against the body bytes; mismatch throws `DigestMismatchError`.
 *
 * Hashes are computed via `crypto.subtle.digest` so any runtime with the
 * Web Crypto API (Node ≥ 19, Bun, Deno, browsers) works without a
 * polyfill. Bodies that arrive as `ReadableStream` are tee'd so the
 * caller's body remains readable — we drain one branch into the digest
 * input and pass the other along to the wire.
 *
 * @example
 * ```ts
 * import { createMisina } from "misina"
 * import { digestAuth, verifyDigest } from "misina/digest"
 *
 * const api = createMisina({ baseURL, use: [digestAuth({ algorithm: "sha-256" })] })
 * const res = await api.post("/upload", body) // Content-Digest auto-added
 *
 * await verifyDigest(res.raw) // throws DigestMismatchError on mismatch
 * ```
 */

import type { MisinaPlugin } from "../types.ts"

export type DigestAlgorithm = "sha-256" | "sha-512"

/** RFC 9530 §1: which header carries the digest. */
export type DigestField = "content-digest" | "repr-digest"

export interface DigestOptions {
  /** Hash algorithm. Default: `'sha-256'`. */
  algorithm?: DigestAlgorithm
  /**
   * Header to write. `'content-digest'` covers the transferred body
   * (RFC 9530 §3); `'repr-digest'` covers the representation before
   * content-coding (§4). Default: `'content-digest'`.
   */
  field?: DigestField
  /**
   * Skip digesting when no body is present (most GETs). Default: true.
   */
  skipEmptyBody?: boolean
}

export class DigestMismatchError extends Error {
  override readonly name = "DigestMismatchError"
  readonly algorithm: string
  readonly expected: string
  readonly actual: string
  constructor(algorithm: string, expected: string, actual: string) {
    super(`Digest mismatch (${algorithm}): expected ${expected}, got ${actual}`)
    this.algorithm = algorithm
    this.expected = expected
    this.actual = actual
  }
}

const ALGO_TO_SUBTLE: Record<DigestAlgorithm, string> = {
  "sha-256": "SHA-256",
  "sha-512": "SHA-512",
}

/**
 * Plugin that automatically generates a `Content-Digest` (or `Repr-Digest`)
 * header on outgoing requests. The hook reads the body bytes, digests them
 * with `crypto.subtle.digest`, and writes a Structured Field dictionary
 * entry of the form `<algo>=:<base64>:` to the configured header.
 *
 * If the request has no body (or `skipEmptyBody` is true and the body is
 * empty) the header is not added.
 */
export function digestAuth(options: DigestOptions = {}): MisinaPlugin {
  const algorithm = options.algorithm ?? "sha-256"
  const field = options.field ?? "content-digest"
  const skipEmptyBody = options.skipEmptyBody ?? true

  return {
    name: "digestAuth",
    hooks: {
      beforeRequest: async (ctx) => {
        const original = ctx.request
        if (!original.body && skipEmptyBody) return
        // Buffer the body for digesting. We re-create the Request with
        // the same bytes so the wire send still has them. For
        // ReadableStream bodies, `Request.bytes()` (or arrayBuffer())
        // drains the stream, which is the only way subtle.digest can
        // see the input — Web Crypto has no incremental API.
        const bytes = new Uint8Array(await original.clone().arrayBuffer())
        if (bytes.byteLength === 0 && skipEmptyBody) return
        const digest = await computeDigest(bytes, algorithm)
        const headers = new Headers(original.headers)
        // RFC 9530 §2: SF dictionary, value is a byte-sequence
        // serialized between `:` colons.
        const existing = headers.get(field)
        const entry = `${algorithm}=:${digest}:`
        headers.set(field, existing ? `${existing}, ${entry}` : entry)
        // Re-issue the Request with the same body bytes (the original
        // stream is now consumed via clone()).
        return new Request(original, {
          headers,
          body: bytes.byteLength === 0 ? null : bytes,
          // Streaming bodies need duplex; a Uint8Array body is buffered
          // so we don't need to set it.
        })
      },
    },
  }
}

/**
 * Verify a response's `Content-Digest` (or `Repr-Digest`) against its
 * body. Throws `DigestMismatchError` on mismatch. Returns silently if
 * the response has no digest header (RFC 9530 says the receiver MUST
 * NOT fail when the field is absent).
 *
 * Reads the body once via `response.clone().arrayBuffer()` so the
 * caller's response stream remains untouched.
 */
export async function verifyDigest(
  response: Response,
  options: { field?: DigestField } = {},
): Promise<void> {
  const field = options.field ?? "content-digest"
  const header = response.headers.get(field)
  if (!header) return

  const entries = parseDigestHeader(header)
  if (entries.length === 0) return

  // Verify each entry. RFC 9530 §1: a sender MAY include multiple
  // algorithms; the receiver should validate at least one it
  // understands and treat unknown algorithms as informational.
  let verifiedAny = false
  for (const { algorithm, expected } of entries) {
    const algo = algorithm.toLowerCase() as DigestAlgorithm
    if (!(algo in ALGO_TO_SUBTLE)) continue
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    const actual = await computeDigest(bytes, algo)
    if (actual !== expected) {
      throw new DigestMismatchError(algo, expected, actual)
    }
    verifiedAny = true
  }
  if (!verifiedAny) {
    // No algorithm we recognize — silently pass per RFC 9530.
  }
}

interface ParsedDigestEntry {
  algorithm: string
  expected: string
}

function parseDigestHeader(header: string): ParsedDigestEntry[] {
  // RFC 9530 SF dictionary. We do a small ad-hoc parser instead of
  // pulling in `_sf.ts` because the byte-sequence serialization here
  // is straightforward: `<algo>=:<base64>:` separated by commas, with
  // optional SF parameters we ignore.
  const out: ParsedDigestEntry[] = []
  for (const raw of header.split(",")) {
    const part = raw.trim()
    if (!part) continue
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const algo = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    // Strip any trailing SF parameters (`;p=q`); they're ignored here.
    const semicolon = value.indexOf(";")
    const naked = (semicolon === -1 ? value : value.slice(0, semicolon)).trim()
    if (!naked.startsWith(":") || !naked.endsWith(":")) continue
    const b64 = naked.slice(1, -1)
    if (!b64) continue
    out.push({ algorithm: algo, expected: b64 })
  }
  return out
}

async function computeDigest(bytes: Uint8Array, algorithm: DigestAlgorithm): Promise<string> {
  const subtle = (globalThis as typeof globalThis & { crypto: Crypto }).crypto.subtle
  const hash = await subtle.digest(ALGO_TO_SUBTLE[algorithm], bytes as BufferSource)
  return base64Encode(new Uint8Array(hash))
}

function base64Encode(bytes: Uint8Array): string {
  // btoa works on binary strings. For Uint8Array we go through the
  // small-chunk path to avoid the call-stack limit on large hashes
  // (digest output is ≤ 64B so this loop runs at most a few times).
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
