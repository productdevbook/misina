import type { MisinaHooks, MisinaOptions } from "./types.ts"

const REPLACE = Symbol("misina.replaceOption")

interface ReplaceWrapper<T> {
  [REPLACE]: true
  value: T
}

/**
 * Wrap a value to signal "replace, don't merge" during deep merge in
 * `.extend()`. Useful when defaults' hooks/headers/searchParams should be
 * overridden rather than concatenated.
 */
export function replaceOption<T>(value: T): T {
  return { [REPLACE]: true, value } as unknown as T
}

function unwrapReplace<T>(value: T): { replace: boolean; value: unknown } {
  if (value !== null && typeof value === "object" && (value as { [REPLACE]?: boolean })[REPLACE]) {
    return { replace: true, value: (value as unknown as ReplaceWrapper<unknown>).value }
  }
  return { replace: false, value }
}

/**
 * Deep-merge two MisinaOptions. Hooks arrays concat. Headers shallow-merge
 * (b wins). Other primitives → b wins. `replaceOption(value)` forces replace.
 */
export function mergeOptions(a: MisinaOptions, b: MisinaOptions): MisinaOptions {
  const out: MisinaOptions = { ...a }

  for (const [key, raw] of Object.entries(b) as [keyof MisinaOptions, unknown][]) {
    const { replace, value } = unwrapReplace(raw)
    if (replace) {
      ;(out as Record<string, unknown>)[key] = value
      continue
    }

    if (key === "headers") {
      out.headers = mergeHeaders(a.headers, value as Record<string, string>)
    } else if (key === "hooks") {
      out.hooks = mergeHookConfigs(a.hooks, value as MisinaHooks)
    } else {
      ;(out as Record<string, unknown>)[key] = value
    }
  }

  return out
}

function mergeHeaders(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...a }
  if (b) for (const [k, v] of Object.entries(b)) out[k] = v
  return out
}

function mergeHookConfigs(a: MisinaHooks | undefined, b: MisinaHooks | undefined): MisinaHooks {
  if (!a) return b ?? {}
  if (!b) return a
  return {
    init: concat(a.init, b.init),
    beforeRequest: concat(a.beforeRequest, b.beforeRequest),
    beforeRetry: concat(a.beforeRetry, b.beforeRetry),
    beforeRedirect: concat(a.beforeRedirect, b.beforeRedirect),
    afterResponse: concat(a.afterResponse, b.afterResponse),
    beforeError: concat(a.beforeError, b.beforeError),
  }
}

function concat<T>(a: T | T[] | undefined, b: T | T[] | undefined): T[] | undefined {
  if (a == null && b == null) return undefined
  return [
    ...(Array.isArray(a) ? a : a == null ? [] : [a]),
    ...(Array.isArray(b) ? b : b == null ? [] : [b]),
  ]
}
