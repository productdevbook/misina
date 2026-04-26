/**
 * Rate-limit header parser. Recognizes the de-facto OpenAI / Anthropic
 * style (`x-ratelimit-*-requests` / `x-ratelimit-*-tokens`) and the IETF
 * draft (`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`).
 * Returns null when no recognized headers are present.
 *
 * Reset values are normalized to a `Date`. The header may carry:
 *   - ISO 8601 string  (`'2026-04-26T15:00:00Z'`)
 *   - Unix seconds     (`'1745680800'` — large absolute, or small relative)
 *   - duration suffix  (`'10s'`, `'500ms'`, `'1m30s'`)
 *
 * No core changes; pair with a token-bucket limiter (#92) or feed into
 * `onComplete` for telemetry.
 */

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
