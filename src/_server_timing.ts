import type { ServerTimingEntry } from "./types.ts"

/**
 * Parser for the W3C Server-Timing header.
 *
 * Format: `metric ['; dur=' value] ['; desc=' value] (',' metric)*`
 *   - quoted desc: `desc="quoted text with spaces"`
 *   - unquoted desc: `desc=token`
 *
 * Metrics that fail to parse are skipped silently — telemetry should
 * never throw on malformed third-party headers.
 *
 * Reference: https://www.w3.org/TR/server-timing/
 */

export function parseServerTiming(header: string | null | undefined): ServerTimingEntry[] {
  if (!header) return []
  const out: ServerTimingEntry[] = []
  for (const raw of splitTopLevel(header)) {
    const entry = parseEntry(raw.trim())
    if (entry) out.push(entry)
  }
  return out
}

function parseEntry(input: string): ServerTimingEntry | null {
  if (!input) return null
  // Split on `;` but respect quoted strings (desc may contain `;` or `,`).
  const parts = splitTopLevel(input, ";")
  const name = parts[0]?.trim()
  if (!name || !isToken(name)) return null
  let dur: number | undefined
  let desc: string | undefined
  for (let i = 1; i < parts.length; i++) {
    const kv = parts[i]!.trim()
    if (!kv) continue
    const eq = kv.indexOf("=")
    if (eq === -1) continue
    const key = kv.slice(0, eq).trim().toLowerCase()
    const rawValue = kv.slice(eq + 1).trim()
    if (key === "dur") {
      const n = Number(rawValue)
      if (Number.isFinite(n)) dur = n
    } else if (key === "desc") {
      desc = unquote(rawValue)
    }
  }
  return { name, dur, desc }
}

/**
 * Split on a delimiter while respecting double-quoted spans. Default
 * delimiter is `,` (the top level for Server-Timing).
 */
function splitTopLevel(input: string, delim = ","): string[] {
  const out: string[] = []
  let current = ""
  let inQuote = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === "\\" && i + 1 < input.length && inQuote) {
      current += ch + input[i + 1]
      i++
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      current += ch
      continue
    }
    if (ch === delim && !inQuote) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

function isToken(value: string): boolean {
  // RFC 7230 token: 1*tchar — a permissive subset is fine here since
  // we only use the result as a key; unparseable values are dropped.
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1")
  }
  return value
}
