import { describe, expect, it } from "vitest"
import { composeSignals } from "../src/_signal.ts"

describe("composeSignals", () => {
  it("returns undefined when no real signals", () => {
    expect(composeSignals([undefined, undefined])).toBeUndefined()
    expect(composeSignals([])).toBeUndefined()
  })

  it("returns the only real signal as-is (no wrapping)", () => {
    const c = new AbortController()
    expect(composeSignals([c.signal, undefined])).toBe(c.signal)
  })

  it("aborts when any source aborts and forwards the reason", () => {
    const a = new AbortController()
    const b = new AbortController()
    const composed = composeSignals([a.signal, b.signal])!
    expect(composed.aborted).toBe(false)
    b.abort(new Error("boom"))
    expect(composed.aborted).toBe(true)
    expect((composed.reason as Error).message).toBe("boom")
  })

  it("returns an already-aborted signal if any source is pre-aborted", () => {
    const a = new AbortController()
    a.abort(new Error("pre"))
    const b = new AbortController()
    const composed = composeSignals([a.signal, b.signal])!
    expect(composed.aborted).toBe(true)
    expect((composed.reason as Error).message).toBe("pre")
  })

  it("removes listeners from sources after firing (no leak on long-lived sources)", () => {
    const long = new AbortController()
    const trackedAdds: unknown[] = []
    const trackedRemoves: unknown[] = []
    const origAdd = long.signal.addEventListener.bind(long.signal)
    const origRemove = long.signal.removeEventListener.bind(long.signal)
    long.signal.addEventListener = ((
      type: string,
      listener: EventListener,
      opts?: AddEventListenerOptions,
    ) => {
      trackedAdds.push(listener)
      origAdd(type, listener, opts)
    }) as typeof long.signal.addEventListener
    long.signal.removeEventListener = ((type: string, listener: EventListener) => {
      trackedRemoves.push(listener)
      origRemove(type, listener)
    }) as typeof long.signal.removeEventListener

    const short = new AbortController()
    const composed = composeSignals([long.signal, short.signal])!
    expect(trackedAdds).toHaveLength(1)

    short.abort()
    expect(composed.aborted).toBe(true)
    expect(trackedRemoves).toHaveLength(1)
    expect(trackedRemoves[0]).toBe(trackedAdds[0])
  })

  it("does not double-abort when both sources fire", () => {
    const a = new AbortController()
    const b = new AbortController()
    const composed = composeSignals([a.signal, b.signal])!
    let fired = 0
    composed.addEventListener("abort", () => fired++)
    a.abort(new Error("first"))
    b.abort(new Error("second"))
    expect(fired).toBe(1)
    expect((composed.reason as Error).message).toBe("first")
  })
})
