import type { MaybeArray, MisinaHooks, ResolvedHooks } from "./types.ts"

export function toArray<T>(value: MaybeArray<T> | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Concatenate two hook configs. Per-request hooks run *after* defaults — a
 * later hook can observe and override an earlier hook's effect.
 */
export function mergeHooks(a: MisinaHooks | undefined, b: MisinaHooks | undefined): ResolvedHooks {
  return {
    init: [...toArray(a?.init), ...toArray(b?.init)],
    beforeRequest: [...toArray(a?.beforeRequest), ...toArray(b?.beforeRequest)],
    beforeRetry: [...toArray(a?.beforeRetry), ...toArray(b?.beforeRetry)],
    afterResponse: [...toArray(a?.afterResponse), ...toArray(b?.afterResponse)],
    beforeError: [...toArray(a?.beforeError), ...toArray(b?.beforeError)],
  }
}
