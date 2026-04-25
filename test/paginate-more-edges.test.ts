import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { paginate, paginateAll } from "../src/paginate/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("paginate — additional edges", () => {
  it("empty first page with no next link → empty array", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse([]),
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number>(m, "https://api.test/p1")
    expect(items).toEqual([])
  })

  it("non-array response with no `data` key, no transform → empty (don't crash)", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse({ totalCount: 0 }),
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll(m, "https://api.test/p1")
    expect(items).toEqual([])
  })

  it("transform throw propagates to caller", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse([1, 2, 3]),
    }
    const m = createMisina({ driver, retry: 0 })

    await expect(
      paginateAll<number>(m, "https://api.test/p1", {
        transform: () => {
          throw new Error("transform-boom")
        },
      }),
    ).rejects.toThrow("transform-boom")
  })

  it("custom next: cursor-based pagination", async () => {
    const pages: Record<string, unknown> = {
      "https://api.test/?cursor=0": { items: [1, 2], next: "abc" },
      "https://api.test/?cursor=abc": { items: [3, 4], next: "xyz" },
      "https://api.test/?cursor=xyz": { items: [5, 6], next: null },
    }
    const driver = {
      name: "cursor",
      request: async (req: Request) => jsonResponse(pages[req.url] ?? { items: [], next: null }),
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number, { items: number[]; next: string | null }>(
      m,
      "https://api.test/?cursor=0",
      {
        transform: (res) => res.data.items,
        next: (res) => {
          const cursor = res.data.next
          if (!cursor) return false
          return { url: `https://api.test/?cursor=${cursor}` }
        },
      },
    )

    expect(items).toEqual([1, 2, 3, 4, 5, 6])
  })

  it("requestLimit 0 yields nothing", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse([1, 2, 3]),
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number>(m, "https://api.test/p1", { requestLimit: 0 })
    expect(items).toEqual([])
  })

  it("countLimit greater than total items returns everything", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        if (calls === 1) {
          return jsonResponse([1, 2, 3], {
            headers: {
              "content-type": "application/json",
              link: '<https://api.test/p2>; rel="next"',
            },
          })
        }
        return jsonResponse([4, 5])
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number>(m, "https://api.test/p1", { countLimit: 999 })
    expect(items).toEqual([1, 2, 3, 4, 5])
  })

  it("filter and countLimit interact: count is post-filter", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse([1, 2, 3, 4, 5, 6, 7, 8]),
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number>(m, "https://api.test/p1", {
      filter: (n) => n % 2 === 0,
      countLimit: 3,
    })
    // Filtered to evens, capped at 3: [2, 4, 6]
    expect(items).toEqual([2, 4, 6])
  })

  it("breaking the iterator does not start a new request", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse([calls], {
          headers: {
            "content-type": "application/json",
            link: `<https://api.test/p${calls + 1}>; rel="next"`,
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const items: number[] = []
    for await (const item of paginate<number>(m, "https://api.test/p1")) {
      items.push(item)
      break
    }

    expect(items).toEqual([1])
    expect(calls).toBe(1)
  })

  it("Link header with multiple rels picks 'next'", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        if (calls === 1) {
          return jsonResponse([1, 2], {
            headers: {
              "content-type": "application/json",
              // RFC 5988 multi-link: prev + next
              link: '<https://api.test/p0>; rel="prev", <https://api.test/p2>; rel="next"',
            },
          })
        }
        return jsonResponse([3, 4])
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const items = await paginateAll<number>(m, "https://api.test/p1")
    expect(items).toEqual([1, 2, 3, 4])
  })
})
