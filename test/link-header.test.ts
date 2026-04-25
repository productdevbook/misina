import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { paginateAll } from "../src/paginate/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("Link header parser (RFC 8288 §3)", () => {
  it("parses a simple rel=next", async () => {
    let calls = 0
    const driver = {
      name: "linker",
      request: async () => {
        calls++
        if (calls === 1) {
          return jsonResponse([1, 2], {
            headers: {
              "content-type": "application/json",
              link: '<https://api.test/p2>; rel="next"',
            },
          })
        }
        return jsonResponse([3])
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const all = await paginateAll<number>(m, "https://api.test/p1")
    expect(all).toEqual([1, 2, 3])
  })

  it("handles URLs containing commas", async () => {
    let calls = 0
    const seenUrls: string[] = []
    const driver = {
      name: "linker",
      request: async (req: Request) => {
        seenUrls.push(req.url)
        calls++
        if (calls === 1) {
          return jsonResponse([1], {
            headers: {
              "content-type": "application/json",
              link: '<https://api.test/items?ids=1,2,3>; rel="next"',
            },
          })
        }
        return jsonResponse([2])
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const all = await paginateAll<number>(m, "https://api.test/p1")

    expect(all).toEqual([1, 2])
    expect(seenUrls[1]).toBe("https://api.test/items?ids=1,2,3")
  })

  it("picks rel=next out of a multi-link header", async () => {
    let calls = 0
    const seenUrls: string[] = []
    const driver = {
      name: "linker",
      request: async (req: Request) => {
        seenUrls.push(req.url)
        calls++
        if (calls === 1) {
          return jsonResponse([1], {
            headers: {
              "content-type": "application/json",
              link: '<https://api.test/p1>; rel="prev", <https://api.test/p2>; rel="next", <https://api.test/last>; rel="last"',
            },
          })
        }
        return jsonResponse([2])
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await paginateAll<number>(m, "https://api.test/p1")

    expect(seenUrls[1]).toBe("https://api.test/p2")
  })

  it("handles space-separated rel values", async () => {
    let calls = 0
    const seenUrls: string[] = []
    const driver = {
      name: "linker",
      request: async (req: Request) => {
        seenUrls.push(req.url)
        calls++
        if (calls === 1) {
          return jsonResponse([1], {
            headers: {
              "content-type": "application/json",
              // RFC 8288 allows multiple rel tokens space-separated
              link: '<https://api.test/p2>; rel="next foo"',
            },
          })
        }
        return jsonResponse([2])
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await paginateAll<number>(m, "https://api.test/p1")

    expect(seenUrls[1]).toBe("https://api.test/p2")
  })

  it("ignores malformed link header entries gracefully", async () => {
    let calls = 0
    const driver = {
      name: "linker",
      request: async () => {
        calls++
        if (calls === 1) {
          return jsonResponse([1], {
            headers: {
              "content-type": "application/json",
              link: "not-a-link-header",
            },
          })
        }
        return jsonResponse([2])
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const all = await paginateAll<number>(m, "https://api.test/p1")

    // Single page — malformed Link means no next.
    expect(all).toEqual([1])
    expect(calls).toBe(1)
  })
})
