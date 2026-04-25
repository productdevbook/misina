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
      out.headers = mergeHeaders(a.headers, value as HeadersInput)
    } else if (key === "hooks") {
      out.hooks = mergeHookConfigs(a.hooks, value as MisinaHooks)
    } else {
      ;(out as Record<string, unknown>)[key] = value
    }
  }

  return out
}

type HeadersInput = HeadersInit | Record<string, string | undefined> | undefined

function mergeHeaders(a: HeadersInput, b: HeadersInput): Record<string, string> {
  // Case-insensitive: lowercased keys, last wins. Otherwise `{ Authorization }`
  // and `{ authorization }` would coexist in the merged record and produce
  // duplicate headers downstream.
  const out: Record<string, string> = {}
  copyInto(out, a)
  copyInto(out, b)
  return out
}

function copyInto(out: Record<string, string>, source: HeadersInput): void {
  if (source == null) return
  const entries: [string, unknown][] =
    source instanceof Headers
      ? [...source.entries()]
      : Array.isArray(source)
        ? (source as [string, unknown][])
        : Object.entries(source as Record<string, unknown>)
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue
    out[k.toLowerCase()] = String(v)
  }
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
