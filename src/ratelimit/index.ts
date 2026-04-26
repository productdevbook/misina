/**
 * Rate-limit header parser + optional client-side token bucket.
 *
 * - `parseRateLimitHeaders(headers)` reads OpenAI-style and IETF-draft
 *   `x-ratelimit-*` headers; returns null when none recognized.
 * - `withRateLimit(misina, opts)` adds an in-process limiter that gates
 *   each request before dispatch, learns the real budget from response
 *   headers, and backs off on 429.
 */

import type { Misina } from "../types.ts"

export interface RateLimitBucket {
  limit: number | undefined
  remaining: number | undefined
  resetAt: Date | undefined
}

export interface RateLimitInfo {
  requests: RateLimitBucket | undefined
  tokens: RateLimitBucket | undefined
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | null {
  const requests = readBucket(headers, "requests")
  const tokens = readBucket(headers, "tokens")
  // IETF draft style has no -requests/-tokens suffix; fall back to that
  // generic form when the OpenAI-style buckets are absent.
  const generic = !requests && !tokens ? readBucket(headers, "") : undefined
  if (!requests && !tokens && !generic) return null
  return {
    requests: requests ?? generic,
    tokens,
  }
}

function readBucket(
  headers: Headers,
  suffix: "requests" | "tokens" | "",
): RateLimitBucket | undefined {
  const sfx = suffix === "" ? "" : `-${suffix}`
  // For named buckets ('requests'/'tokens'), only consider headers that
  // actually carry the suffix. Falling through to the generic 'ratelimit-*'
  // would let the same generic value be reported as both 'requests' and
  // 'tokens' — the generic bucket is handled explicitly by parseRateLimitHeaders.
  const limit = pickNumber(headers, [`x-ratelimit-limit${sfx}`, `ratelimit-limit${sfx}`])
  const remaining = pickNumber(headers, [
    `x-ratelimit-remaining${sfx}`,
    `ratelimit-remaining${sfx}`,
  ])
  const resetAt = pickReset(headers, [`x-ratelimit-reset${sfx}`, `ratelimit-reset${sfx}`])
  if (limit === undefined && remaining === undefined && resetAt === undefined) return undefined
  return { limit, remaining, resetAt }
}

function pickNumber(headers: Headers, names: string[]): number | undefined {
  for (const n of names) {
    const v = headers.get(n)
    if (v == null) continue
    const num = Number(v.trim())
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function pickReset(headers: Headers, names: string[]): Date | undefined {
  for (const n of names) {
    const v = headers.get(n)
    if (v == null) continue
    const parsed = parseResetValue(v.trim())
    if (parsed) return parsed
  }
  return undefined
}

function parseResetValue(value: string): Date | undefined {
  if (value === "") return undefined
  const dur = parseDuration(value)
  if (dur !== undefined) return new Date(Date.now() + dur)
  if (/^\d+$/.test(value)) {
    const n = Number(value)
    // Heuristic: very small numbers are seconds-from-now, larger are
    // absolute Unix seconds. Threshold ~100k seconds (~28 hours).
    if (n < 100_000) return new Date(Date.now() + n * 1000)
    return new Date(n * 1000)
  }
  const ts = Date.parse(value)
  if (!Number.isNaN(ts)) return new Date(ts)
  return undefined
}

function parseDuration(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) return undefined
  let total = 0
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    const n = Number(match[1])
    switch (match[2]) {
      case "ms":
        total += n
        break
      case "s":
        total += n * 1000
        break
      case "m":
        total += n * 60_000
        break
      case "h":
        total += n * 3_600_000
        break
    }
  }
  return total
}

export interface RateLimitOptions {
  /** Initial requests-per-minute budget. Default: Infinity (unlimited). */
  rpm?: number
  /** Initial tokens-per-minute budget. Default: Infinity (unlimited). */
  tpm?: number
  /**
   * Estimate token cost for a request before dispatch. Used to acquire
   * tokens from the TPM bucket. Return 0 to skip the TPM gate for a
   * request. Default: () => 0 (no TPM accounting).
   */
  estimateTokens?: (request: Request) => number
  /**
   * Override the source of "now" — useful in tests with fake timers.
   * Default: `() => Date.now()`.
   */
  now?: () => number
}

/**
 * Token-bucket rate limiter wired into a `Misina` instance via hooks.
 * Two buckets — requests-per-minute and tokens-per-minute — refill
 * linearly. `beforeRequest` waits until both buckets cover the cost.
 * `onComplete` reads `x-ratelimit-remaining-*` and adjusts the bucket
 * to the real budget the server reports. 429 responses drain both
 * buckets aggressively so subsequent calls back off.
 */
export function withRateLimit(misina: Misina, options: RateLimitOptions = {}): Misina {
  const now = options.now ?? ((): number => Date.now())
  const estimate = options.estimateTokens ?? ((): number => 0)

  const requests = createBucket(options.rpm ?? Number.POSITIVE_INFINITY, now)
  const tokens = createBucket(options.tpm ?? Number.POSITIVE_INFINITY, now)

  return misina.extend({
    hooks: {
      beforeRequest: async (ctx) => {
        const cost = Math.max(0, estimate(ctx.request))
        await requests.acquire(1, ctx.options.signal)
        if (cost > 0) await tokens.acquire(cost, ctx.options.signal)
      },
      onComplete: ({ response }) => {
        if (!response) return
        const info = parseRateLimitHeaders(response.headers)
        if (info?.requests?.remaining !== undefined) {
          requests.observeRemaining(info.requests.remaining, info.requests.resetAt)
        }
        if (info?.tokens?.remaining !== undefined) {
          tokens.observeRemaining(info.tokens.remaining, info.tokens.resetAt)
        }
        if (response.status === 429) {
          requests.drainAndBackoff(info?.requests?.resetAt)
          tokens.drainAndBackoff(info?.tokens?.resetAt)
        }
      },
    },
  })
}

interface Bucket {
  acquire(cost: number, signal: AbortSignal | undefined): Promise<void>
  observeRemaining(remaining: number, resetAt: Date | undefined): void
  drainAndBackoff(resetAt: Date | undefined): void
}

function createBucket(initialPerMinute: number, now: () => number): Bucket {
  // capacity: max budget per minute. ratePerMs: refill rate.
  let capacity = initialPerMinute
  let available = capacity
  let lastTick = now()
  // Time at which the bucket should be considered full again; honored
  // when the server tells us when reset happens (resetAt). When set,
  // refill is gated by `until` rather than the linear ratePerMs path.
  let bypassUntil = 0

  function refill(): void {
    const t = now()
    if (capacity === Number.POSITIVE_INFINITY) {
      available = Number.POSITIVE_INFINITY
      lastTick = t
      return
    }
    const elapsed = t - lastTick
    if (elapsed > 0) {
      // capacity tokens per 60_000 ms.
      available = Math.min(capacity, available + (elapsed * capacity) / 60_000)
      lastTick = t
    }
  }

  return {
    async acquire(cost: number, signal: AbortSignal | undefined): Promise<void> {
      if (capacity === Number.POSITIVE_INFINITY) return
      while (true) {
        refill()
        if (bypassUntil > now()) {
          await sleep(bypassUntil - now(), signal)
          continue
        }
        if (available >= cost) {
          available -= cost
          return
        }
        // Need (cost - available) more tokens; wait long enough to refill.
        const deficit = cost - available
        const waitMs = Math.max(50, Math.ceil((deficit * 60_000) / capacity))
        await sleep(waitMs, signal)
      }
    },
    observeRemaining(remaining: number, resetAt: Date | undefined): void {
      if (!Number.isFinite(remaining) || remaining < 0) return
      // Trust the server's number — it's authoritative.
      available = Math.min(capacity, remaining)
      lastTick = now()
      // If the reset moment is known, bypass refill until then if we're
      // already at zero (server has told us we're tapped out).
      if (remaining === 0 && resetAt) {
        bypassUntil = Math.max(bypassUntil, resetAt.getTime())
      }
    },
    drainAndBackoff(resetAt: Date | undefined): void {
      available = 0
      lastTick = now()
      if (resetAt) bypassUntil = Math.max(bypassUntil, resetAt.getTime())
      else bypassUntil = Math.max(bypassUntil, now() + 1000)
    },
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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
