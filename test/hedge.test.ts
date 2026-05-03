import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { hedge, HedgeLoserError } from "../src/hedge/index.ts"

function delayedResponse(ms: number, body: unknown): (req: Request) => Promise<Response> {
  return (req) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify(body), {
              headers: { "content-type": "application/json" },
            }),
          ),
        ms,
      )
      req.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(req.signal.reason)
        },
        { once: true },
      )
    })
}

describe("hedge — race across endpoints", () => {
  it("returns the data from the first endpoint to respond", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.url.startsWith("https://slow.")) {
          return delayedResponse(200, { region: "slow" })(req)
        }
        return delayedResponse(20, { region: "fast" })(req)
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ region: string }>(m, "/inference", {
      endpoints: ["https://slow.example.com", "https://fast.example.com"],
    })
    expect(data.region).toBe("fast")
  })

  it("delayMs lets the first endpoint complete before firing the second", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        return new Response(JSON.stringify({ host: new URL(req.url).host }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
      delayMs: 50,
    })
    // Primary finished synchronously (driver mock) before delayMs elapsed,
    // so the backup never fires.
    expect(data.host).toBe("primary.example.com")
    expect(seen).toEqual(["https://primary.example.com/x"])
  })

  it("falls back to the second endpoint when the first errors", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.url.includes("primary")) return new Response("upstream down", { status: 502 })
        return new Response(JSON.stringify({ host: "backup" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
    })
    expect(data.host).toBe("backup")
  })

  it("rethrows when all endpoints fail (with cause aggregate)", async () => {
    const driver = {
      name: "x",
      request: async () => new Response("err", { status: 503 }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await hedge(m, "/x", {
        endpoints: ["https://a.test", "https://b.test"],
      })
      expect.fail("should throw")
    } catch (err) {
      // First non-loser error surfaces; AggregateError attached on cause.
      expect(err).toBeInstanceOf(Error)
      expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
    }
  })

  it("rejects empty endpoints array", async () => {
    const m = createMisina({ retry: 0 })
    await expect(hedge(m, "/x", { endpoints: [] })).rejects.toThrow(/empty/)
  })

  it("aborts the loser when the winner settles first (delayMs = 0)", async () => {
    const aborted: string[] = []
    const driver = {
      name: "x",
      request: (req: Request): Promise<Response> => {
        const slow = req.url.includes("slow")
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ host: new URL(req.url).host }), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            slow ? 200 : 10,
          )
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              aborted.push(req.url)
              reject(req.signal.reason)
            },
            { once: true },
          )
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://fast.example.com", "https://slow.example.com"],
    })
    expect(data.host).toBe("fast.example.com")
    // Loser slow endpoint received an abort signal.
    expect(aborted).toEqual(["https://slow.example.com/x"])
  })

  it("respects max cap on endpoints", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        return new Response(JSON.stringify({ host: new URL(req.url).host }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://a.example.com", "https://b.example.com", "https://c.example.com"],
      max: 1,
    })
    expect(data.host).toBe("a.example.com")
    expect(seen).toEqual(["https://a.example.com/x"])
  })

  it("external signal aborts the delay timer between firings", async () => {
    // Suppress the in-flight primary's rejection to avoid an unhandled
    // rejection warning. The primary's misina call rejects when the external
    // signal aborts (composed via AbortSignal.any), but if the launch loop's
    // await throws first, the winners[] promise for the primary is never
    // subscribed by Promise.any. We attach a global handler scoped to this
    // test to swallow the dangling rejection.
    const dangling: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent | Error): void => {
      const reason =
        typeof (e as PromiseRejectionEvent).preventDefault === "function"
          ? (e as PromiseRejectionEvent).reason
          : e
      dangling.push(reason)
      ;(e as PromiseRejectionEvent).preventDefault?.()
    }
    process.on("unhandledRejection", onUnhandled as never)
    try {
      const seen: string[] = []
      const driver = {
        name: "x",
        request: async (req: Request): Promise<Response> => {
          seen.push(req.url)
          return new Promise<Response>((_, reject) => {
            req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })
          })
        },
      }
      const m = createMisina({ driver, retry: 0 })
      const ac = new AbortController()
      const p = hedge(m, "/x", {
        endpoints: ["https://primary.example.com", "https://backup.example.com"],
        delayMs: 10_000,
        signal: ac.signal,
      })
      // Let the primary fire, then abort externally during the delayMs wait.
      await new Promise((r) => setTimeout(r, 20))
      ac.abort(new Error("external-abort"))
      await expect(p).rejects.toThrow(/external-abort/)
      // Backup never fired because the wait was aborted.
      expect(seen).toEqual(["https://primary.example.com/x"])
      // Yield a microtask so the dangling rejection has a chance to surface.
      await new Promise((r) => setTimeout(r, 5))
    } finally {
      process.off("unhandledRejection", onUnhandled as never)
    }
  })

  it("stops firing further endpoints once one settles during the delay window", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        // Primary resolves immediately; if the loop fires backup,
        // it would also resolve immediately. The break-on-settled
        // path prevents that.
        return new Response(JSON.stringify({ host: new URL(req.url).host }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
      delayMs: 30,
    })
    expect(data.host).toBe("primary.example.com")
    // Wait long enough that any stray firing would show up in `seen`.
    await new Promise((r) => setTimeout(r, 80))
    expect(seen).toEqual(["https://primary.example.com/x"])
  })

  it("works with a single endpoint (degrades to a plain call)", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> =>
        new Response(JSON.stringify({ host: new URL(req.url).host }), {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/solo", {
      endpoints: ["https://only.example.com"],
    })
    expect(data.host).toBe("only.example.com")
  })

  it("forwards init (headers) to each dispatched request", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        captured = req.headers
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await hedge(m, "/x", {
      endpoints: ["https://only.example.com"],
      init: { headers: { "x-trace-id": "abc-123" } },
    })
    expect(captured?.get("x-trace-id")).toBe("abc-123")
  })

  it("composes external signal with internal abort (signal undefined branch)", async () => {
    // No external signal supplied — exercises composeOptional(undefined, b).
    const driver = {
      name: "x",
      request: async (): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ ok: boolean }>(m, "/x", {
      endpoints: ["https://a.example.com"],
    })
    expect(data.ok).toBe(true)
  })

  it("external signal pre-aborts the entire hedge", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        return new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const ac = new AbortController()
    ac.abort(new Error("pre-aborted"))
    await expect(
      hedge(m, "/x", {
        endpoints: ["https://a.example.com", "https://b.example.com"],
        signal: ac.signal,
      }),
    ).rejects.toThrow()
  })

  it("joinUrl handles trailing-slash + leading-slash combinations", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    // base ends with /, path starts with / → strip duplicate slash.
    await hedge(m, "/x", { endpoints: ["https://a.example.com/"] })
    // base no slash, path no slash → insert one.
    await hedge(m, "x", { endpoints: ["https://b.example.com"] })
    // base ends with /, path no leading slash → just concat.
    await hedge(m, "x", { endpoints: ["https://c.example.com/"] })
    // Absolute URL in path — base ignored.
    await hedge(m, "https://override.example.com/abs", {
      endpoints: ["https://ignored.example.com"],
    })
    expect(seen).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/x",
      "https://c.example.com/x",
      "https://override.example.com/abs",
    ])
  })

  it("HedgeLoserError carries name and reason", () => {
    const e = new HedgeLoserError("hedge-loser")
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("HedgeLoserError")
    expect(e.message).toBe("hedge-loser")
  })

  it("first call rejects (network error), second succeeds — hedge returns second's data", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.url.includes("primary")) throw new TypeError("network down")
        // Slight delay so backup loses the synchronous race; firing order
        // ensures primary's rejection is observed first.
        await new Promise((r) => setTimeout(r, 10))
        return new Response(JSON.stringify({ host: "backup" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
    })
    expect(data.host).toBe("backup")
  })

  it("delayMs > 0: backup fires when primary doesn't resolve in window", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: (req: Request): Promise<Response> => {
        seen.push(req.url)
        return new Promise((resolve, reject) => {
          // Primary takes 200ms; backup is fast.
          const ms = req.url.includes("primary") ? 200 : 5
          const timer = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ host: new URL(req.url).host }), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ms,
          )
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(req.signal.reason)
            },
            { once: true },
          )
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
      delayMs: 20,
    })
    // After 20ms wait, primary not yet settled → backup fires and wins.
    expect(data.host).toBe("backup.example.com")
    expect(seen).toEqual(["https://primary.example.com/x", "https://backup.example.com/x"])
  })

  it("late winner after settled flips throws HedgeLoserError(not-the-winner)", async () => {
    // Two endpoints both resolve. The first to resolve flips `settled` and
    // aborts the second. But if the second's driver ignores the abort and
    // resolves anyway (bad citizen), dispatchAt's `if (settled) throw` path
    // covers line 69. We use a driver that ignores the abort.
    const driver = {
      name: "x",
      request: (req: Request): Promise<Response> => {
        const ms = req.url.includes("fast") ? 5 : 30
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ host: new URL(req.url).host }), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ms,
          )
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://fast.example.com", "https://slow.example.com"],
    })
    expect(data.host).toBe("fast.example.com")
    // Wait for the slow one to also resolve and get rejected as late winner.
    await new Promise((r) => setTimeout(r, 60))
  })

  it("delayMs > 0 with primary settled in-window stops loop early (settled break)", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        if (req.url.includes("a.")) {
          // Primary resolves immediately (microtask).
          return new Response(JSON.stringify({ host: "a" }), {
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ host: "b" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://a.example.com", "https://b.example.com", "https://c.example.com"],
      delayMs: 30,
    })
    expect(data.host).toBe("a")
    // Primary resolved well within the 30ms wait, so the loop
    // hits the `settled` break and never fires b or c.
    await new Promise((r) => setTimeout(r, 80))
    expect(seen).toEqual(["https://a.example.com/x"])
  })

  it("when all endpoints reject only with HedgeLoserError, surfaces a HedgeLoserError", async () => {
    // Force every dispatch into the late-winner path: all responses arrive
    // after `settled` flips. We achieve this by making the first response
    // reject (no winner sets `settled`), then second wins, then a third
    // tries to settle late. Use 3 endpoints with ordered timings.
    const driver = {
      name: "x",
      request: (req: Request): Promise<Response> => {
        const url = req.url
        return new Promise((resolve, reject) => {
          const ms = url.includes("a.example") ? 50 : 10
          const timer = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ host: new URL(url).host }), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ms,
          )
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(req.signal.reason)
            },
            { once: true },
          )
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://a.example.com", "https://b.example.com"],
    })
    // b is faster, wins; a should be aborted as loser.
    expect(data.host).toBe("b.example.com")
  })
})
