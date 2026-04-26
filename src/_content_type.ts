/**
 * Content-type matchers per RFC 6838 (media type) + RFC 6839 (structured
 * syntax suffixes). Shared by body parsing and problem+json extraction.
 *
 * Examples that count as JSON:
 *   - application/json
 *   - application/json; charset=utf-8
 *   - application/problem+json (RFC 9457)
 *   - application/vnd.contentful.management.v1+json (RFC 6839 suffix)
 *   - application/ld+json (linked data)
 *
 * Examples that do NOT count:
 *   - text/json (rare; not standard, RFC 8259 explicitly says only
 *     application/json)
 *   - application/json5 (different format)
 */

const JSON_RE = /^application\/(?:[\w!#$%&*.^`~-]*\+)?json(?:;.*)?$/i
const PROBLEM_JSON_RE = /^application\/problem\+json(?:;.*)?$/i

export function isJsonContentType(ct: string | null | undefined): boolean {
  if (!ct) return false
  return JSON_RE.test(ct.trim())
}

export function isProblemJsonContentType(ct: string | null | undefined): boolean {
  if (!ct) return false
  return PROBLEM_JSON_RE.test(ct.trim())
}
