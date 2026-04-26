import type { HttpMethod, MisinaResolvedOptions, ResolvedRetry } from "./types.ts"

const DEFAULT_METHODS: HttpMethod[] = ["GET", "PUT", "HEAD", "DELETE", "OPTIONS", "QUERY"]
const DEFAULT_STATUS: number[] = [408, 413, 429, 500, 502, 503, 504]
const DEFAULT_AFTER_STATUS: number[] = [413, 429, 503]

export function resolveRetry(
  input: number | boolean | Partial<ResolvedRetry> | undefined,
  fallback?: ResolvedRetry,
): ResolvedRetry {
  if (input === false) return makeRetry({ limit: 0 }, fallback)
  if (input === true) return makeRetry({ limit: 2 }, fallback)
  if (typeof input === "number") return makeRetry({ limit: input }, fallback)
  return makeRetry(input ?? {}, fallback)
}

function makeRetry(input: Partial<ResolvedRetry>, fallback?: ResolvedRetry): ResolvedRetry {
  return {
    limit: input.limit ?? fallback?.limit ?? 2,
    methods: input.methods ?? fallback?.methods ?? DEFAULT_METHODS,
    statusCodes: input.statusCodes ?? fallback?.statusCodes ?? DEFAULT_STATUS,
    afterStatusCodes: input.afterStatusCodes ?? fallback?.afterStatusCodes ?? DEFAULT_AFTER_STATUS,
    maxRetryAfter: input.maxRetryAfter ?? fallback?.maxRetryAfter,
    delay: input.delay ?? fallback?.delay ?? defaultDelay,
    backoffLimit: input.backoffLimit ?? fallback?.backoffLimit ?? Infinity,
    jitter: input.jitter ?? fallback?.jitter ?? false,
    shouldRetry: input.shouldRetry ?? fallback?.shouldRetry,
    retryOnTimeout: input.retryOnTimeout ?? fallback?.retryOnTimeout ?? true,
  }
}

function defaultDelay(attempt: number): number {
  return 0.3 * 2 ** (attempt - 1) * 1000
}

/**
 * Compute delay for the next retry. Honors `Retry-After` and
 * `RateLimit-Reset` headers when the status is in `afterStatusCodes`.
 */
export function calculateRetryDelay(
  retry: ResolvedRetry,
  attempt: number,
  response: Response | undefined,
): number {
  let delay: number

  if (response && retry.afterStatusCodes.includes(response.status)) {
    const fromHeader = parseRetryAfter(response)
    if (fromHeader != null) {
      if (retry.maxRetryAfter != null && fromHeader > retry.maxRetryAfter) {
        return retry.maxRetryAfter
      }
      return fromHeader
    }
  }

  delay = retry.delay(attempt)
  if (delay > retry.backoffLimit) delay = retry.backoffLimit
  if (retry.jitter) {
    delay = typeof retry.jitter === "function" ? retry.jitter(delay) : Math.random() * delay
  }
  return delay
}

function parseRetryAfter(response: Response): number | null {
  // OpenAI and Anthropic SDKs honor `retry-after-ms` (sub-second precision)
  // ahead of the standard `Retry-After` header. Check it first.
  const ms = response.headers.get("retry-after-ms")
  if (ms != null) {
    const t = ms.trim()
    if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t)
  }
  const raw = response.headers.get("retry-after") ?? response.headers.get("ratelimit-reset")
  if (raw == null) return null
  const value = raw.trim()
  if (value === "") return null
  // Number("") would be 0; we already filtered that. Allow only digit-only
  // tokens to take the seconds path so "1.5e3" / "0x10" / "  " don't slip in.
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

/**
 * Read the `x-should-retry` server hint. `'true'` forces retry; `'false'`
 * forbids it. Anything else (including absence) returns null and lets
 * default policy decide. OpenAI and Anthropic SDKs honor this.
 */
export function readXShouldRetry(response: Response): boolean | null {
  const v = response.headers.get("x-should-retry")
  if (v == null) return null
  const t = v.trim().toLowerCase()
  if (t === "true") return true
  if (t === "false") return false
  return null
}

export function shouldRetryNetworkError(
  retry: ResolvedRetry,
  options: MisinaResolvedOptions,
): boolean {
  return retry.methods.includes(options.method)
}

export function shouldRetryHttpError(
  retry: ResolvedRetry,
  options: MisinaResolvedOptions,
  response: Response,
): boolean {
  // x-should-retry overrides default policy in either direction, but only
  // for methods that retry can act on at all.
  if (!retry.methods.includes(options.method)) return false
  const hint = readXShouldRetry(response)
  if (hint === false) return false
  if (hint === true) return true
  return retry.statusCodes.includes(response.status)
}

export function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(id)
        reject(signal.reason)
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
