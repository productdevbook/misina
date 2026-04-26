/**
 * AWS Signature Version 4 signer — zero-dep, Web Crypto only.
 *
 * `sigv4(opts)` is a Misina plugin that signs every outgoing request with
 * the standard AWS SigV4 algorithm:
 *
 *   1. Build the canonical request (method + canonical URI + canonical
 *      query + canonical headers + signed-headers list + payload hash).
 *   2. Build the string-to-sign (`AWS4-HMAC-SHA256` + ISO8601 date +
 *      credential scope + sha256(canonical-request)).
 *   3. Derive the signing key via the HMAC-SHA256 chain
 *      (`AWS4`+secret → date → region → service → "aws4_request").
 *   4. Sign the string-to-sign with the signing key and emit
 *      `Authorization: AWS4-HMAC-SHA256 Credential=... SignedHeaders=...
 *      Signature=...` plus `x-amz-date` and `x-amz-content-sha256`.
 *
 * No SDK peer dep — `crypto.subtle` does HMAC-SHA256 and SHA-256 across
 * Node 19+, Bun, Deno, Cloudflare Workers, and Baseline 2024 browsers.
 *
 * @example
 * ```ts
 * import { createMisina } from "misina"
 * import { sigv4 } from "misina/auth/sigv4"
 *
 * const api = createMisina({
 *   baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
 *   use: [
 *     sigv4({
 *       service: "bedrock-runtime",
 *       region: "us-east-1",
 *       credentials: async () => ({ accessKeyId, secretAccessKey, sessionToken }),
 *     }),
 *   ],
 * })
 * ```
 */

import type { MisinaPlugin } from "../types.ts"

export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SigV4Options {
  service: string
  region: string
  credentials: SigV4Credentials | (() => SigV4Credentials | Promise<SigV4Credentials>)
  /**
   * Skip body hashing and emit `UNSIGNED-PAYLOAD`. Required for true
   * streaming uploads where the body length / hash isn't known up
   * front. Default: false.
   */
  unsignedPayload?: boolean
}

const ALGORITHM = "AWS4-HMAC-SHA256"

/**
 * Sign every request with AWS SigV4. Runs as a `beforeRequest` hook so the
 * Request that hits the driver already carries `Authorization`,
 * `x-amz-date`, and `x-amz-content-sha256`.
 */
export function sigv4(options: SigV4Options): MisinaPlugin {
  return {
    name: "sigv4",
    hooks: {
      beforeRequest: async (ctx) => {
        const creds =
          typeof options.credentials === "function"
            ? await options.credentials()
            : options.credentials
        return await signRequest(ctx.request, {
          service: options.service,
          region: options.region,
          credentials: creds,
          unsignedPayload: options.unsignedPayload ?? false,
        })
      },
    },
  }
}

export interface SignRequestOptions {
  service: string
  region: string
  credentials: SigV4Credentials
  /** Override the timestamp (defaults to now). Used by tests + replay. */
  date?: Date
  unsignedPayload?: boolean
}

/**
 * Sign a single Request and return a new Request with the SigV4
 * headers attached. Pure — no instance / hook required.
 */
export async function signRequest(request: Request, options: SignRequestOptions): Promise<Request> {
  const date = options.date ?? new Date()
  const amzDate = formatAmzDate(date)
  const dateStamp = amzDate.slice(0, 8)

  // Drain body for hashing. Streaming bodies forced through unsignedPayload.
  let bodyBytes: Uint8Array | undefined
  let payloadHash: string
  if (options.unsignedPayload) {
    payloadHash = "UNSIGNED-PAYLOAD"
  } else if (request.body) {
    const buf = await request.clone().arrayBuffer()
    bodyBytes = new Uint8Array(buf)
    payloadHash = await sha256Hex(bodyBytes)
  } else {
    payloadHash = await sha256Hex(new Uint8Array(0))
  }

  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  // SigV4 mandates a Host header in the signature; the runtime adds
  // it automatically on dispatch but we need it in the canonical
  // headers up front.
  if (!headers.has("host")) headers.set("host", url.host)
  headers.set("x-amz-date", amzDate)
  headers.set("x-amz-content-sha256", payloadHash)
  if (options.credentials.sessionToken) {
    headers.set("x-amz-security-token", options.credentials.sessionToken)
  }

  const sortedHeaderNames = Array.from(headers.keys())
    .map((h) => h.toLowerCase())
    .sort()
  const signedHeaders = sortedHeaderNames.join(";")
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${(headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("")

  const canonicalQuery = canonicalQueryString(url.searchParams)
  const canonicalUri = canonicalUriPath(url.pathname)

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const credentialScope = `${dateStamp}/${options.region}/${options.service}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n")

  const signingKey = await deriveSigningKey(
    options.credentials.secretAccessKey,
    dateStamp,
    options.region,
    options.service,
  )
  const signature = bytesToHex(
    new Uint8Array(await hmacSha256(signingKey, new TextEncoder().encode(stringToSign))),
  )

  const authorization =
    `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  headers.set("authorization", authorization)

  // Re-issue the request with the same body bytes (we drained one
  // clone above; the original body, if any, is still intact since we
  // worked on a clone).
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
  }
  if (bodyBytes && bodyBytes.byteLength > 0) {
    init.body = bodyBytes as BodyInit
  } else if (request.body && options.unsignedPayload) {
    // Streaming body kept as-is (we didn't drain it).
    init.body = request.body
    init.duplex = "half"
  }
  return new Request(request.url, init)
}

/* ----------------------------------------------------------------------- */
/*                              SigV4 internals                              */
/* ----------------------------------------------------------------------- */

function formatAmzDate(date: Date): string {
  // YYYYMMDDTHHMMSSZ
  const pad = (n: number): string => n.toString().padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

function canonicalQueryString(params: URLSearchParams): string {
  // RFC 3986 percent-encode each name and value, then sort by name
  // (stable on equal names: keep value order).
  const entries: Array<[string, string]> = []
  for (const [k, v] of params.entries()) {
    entries.push([rfc3986Encode(k), rfc3986Encode(v)])
  }
  entries.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
  return entries.map(([k, v]) => `${k}=${v}`).join("&")
}

function canonicalUriPath(path: string): string {
  if (path === "" || path === "/") return "/"
  // SigV4 requires double-encoding for everything except S3. The Bedrock
  // / Lambda / SQS surface follows the default rule. We percent-encode
  // each path segment per RFC 3986 once; if a service requires the
  // double-encoded variant the caller should set their own canonical URI
  // before signing (this is what the AWS SDK does too).
  return path
    .split("/")
    .map((seg) => (seg ? rfc3986Encode(seg) : ""))
    .join("/")
}

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as typeof globalThis & { crypto: Crypto }).crypto.subtle
  const hash = await subtle.digest("SHA-256", bytes as BufferSource)
  return bytesToHex(new Uint8Array(hash))
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const subtle = (globalThis as typeof globalThis & { crypto: Crypto }).crypto.subtle
  const cryptoKey = await subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return subtle.sign("HMAC", cryptoKey, data as BufferSource)
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const kSecret = enc.encode(`AWS4${secretAccessKey}`)
  const kDate = new Uint8Array(await hmacSha256(kSecret, enc.encode(dateStamp)))
  const kRegion = new Uint8Array(await hmacSha256(kDate, enc.encode(region)))
  const kService = new Uint8Array(await hmacSha256(kRegion, enc.encode(service)))
  return new Uint8Array(await hmacSha256(kService, enc.encode("aws4_request")))
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += b.toString(16).padStart(2, "0")
  }
  return out
}
