/**
 * Sentry adapter — captures misina errors with the originating request
 * as Sentry context. Adds optional breadcrumbs for successful requests.
 *
 * No package dependency: pass any object that satisfies the minimal
 * `SentryHub` shape (`@sentry/browser`, `@sentry/node`, `@sentry/core`,
 * or your own wrapper). No peer dep — you already install Sentry yourself.
 *
 * @example
 * ```ts
 * import * as Sentry from "@sentry/browser"
 * import { createMisina } from "misina"
 * import { sentry } from "misina/sentry"
 *
 * const api = createMisina({
 *   baseURL,
 *   use: [sentry({ Sentry, captureLevel: "error", redactHeaders: ["authorization", "cookie"] })],
 * })
 * ```
 */

import type { MisinaPlugin } from "../types.ts"

/** Minimal Sentry surface used by the adapter. */
export interface SentryHub {
  captureException: (
    error: unknown,
    context?: { contexts?: Record<string, unknown>; tags?: Record<string, string> },
  ) => string | undefined
  addBreadcrumb?: (breadcrumb: SentryBreadcrumb) => void
}

export interface SentryBreadcrumb {
  category?: string
  message?: string
  level?: "debug" | "info" | "warning" | "error" | "fatal"
  type?: string
  data?: Record<string, unknown>
}

export interface SentryOptions {
  Sentry: SentryHub
  /**
   * Which errors to capture:
   * - `'all'`: every error (HTTP + network + timeout)
   * - `'error'` (default): everything except 4xx HTTPError
   * - `'5xx'`: only HTTPError with status ≥ 500
   */
  captureLevel?: "all" | "error" | "5xx"
  /**
   * Header names to redact in the captured request context.
   * Default: `['authorization', 'cookie', 'proxy-authorization']`.
   */
  redactHeaders?: string[]
  /** Add a breadcrumb on every successful request. Default: false. */
  successBreadcrumb?: boolean
}

const DEFAULT_REDACT = ["authorization", "cookie", "proxy-authorization"]

export function sentry(options: SentryOptions): MisinaPlugin {
  const captureLevel = options.captureLevel ?? "error"
  const redact = new Set((options.redactHeaders ?? DEFAULT_REDACT).map((h) => h.toLowerCase()))
  const successBreadcrumb = options.successBreadcrumb ?? false

  return {
    name: "sentry",
    hooks: {
      beforeError: (error, ctx) => {
        if (!shouldCapture(error, captureLevel)) return error
        const status =
          (error as { status?: number; response?: Response }).status ??
          (error as { response?: Response }).response?.status
        const requestId = (error as { requestId?: string }).requestId
        options.Sentry.captureException(error, {
          contexts: {
            request: {
              method: ctx.request.method,
              url: ctx.request.url,
              headers: redactHeaders(ctx.request.headers, redact),
            },
            ...(status !== undefined ? { response: { status } } : {}),
          },
          ...(requestId ? { tags: { request_id: requestId } } : {}),
        })
        return error
      },
      onComplete: ({ request, response, error }) => {
        if (!successBreadcrumb || error || !response) return
        options.Sentry.addBreadcrumb?.({
          category: "fetch",
          message: `${request.method} ${request.url}`,
          level: "info",
          type: "http",
          data: { status: response.status },
        })
      },
    },
  }
}

function shouldCapture(error: unknown, level: "all" | "error" | "5xx"): boolean {
  if (level === "all") return true
  const status = (error as { status?: number }).status
  if (level === "5xx") return typeof status === "number" && status >= 500
  // 'error' default: capture everything except 4xx HTTPError (client mistakes).
  if (typeof status === "number" && status >= 400 && status < 500) return false
  return true
}

function redactHeaders(headers: Headers, redact: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers.entries()) {
    out[k] = redact.has(k.toLowerCase()) ? "[redacted]" : v
  }
  return out
}
