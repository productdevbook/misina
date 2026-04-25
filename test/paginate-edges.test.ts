import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { paginate, paginateAll } from "../src/paginate/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("paginate — async transform", () => {
  it("awaits async transform before yielding items", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        if (calls === 1) {
          return jsonResponse(
            { items: [1, 2] },
            {
              headers: {
                "content-type": "application/json",
                link: '<https://api.test/p2>; rel="next"',
              },
            },
          )
        }
        return jsonResponse({ items: [3] })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const all = await paginateAll<number>(m, "https://api.test/p1", {
      transform: async (res) => {
        await new Promise((r) => setTimeout(r, 5))
        return ((res.data as { items: number[] }).items ?? []).map((n) => n * 2)
      },
    })

    expect(all).toEqual([2, 4, 6])
  })
})

describe("paginate — filter", () => {
  it("filter removes items but keeps following pages", async () => {
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
        return jsonResponse([4, 5, 6])
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const evens = await paginateAll<number>(m, "https://api.test/p1", {
      filter: (n) => n % 2 === 0,
    })
    expect(evens).toEqual([2, 4, 6])
  })

  it("filter that rejects everything still walks all pages until next() stops", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        if (calls < 3) {
          return jsonResponse([1, 2], {
            headers: {
              "content-type": "application/json",
              link: `<https://api.test/p${calls + 1}>; rel="next"`,
            },
          })
        }
        return jsonResponse([3, 4])
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const all = await paginateAll<number>(m, "https://api.test/p1", {
      filter: () => false,
    })
    expect(all).toEqual([])
    expect(calls).toBe(3)
  })
})

describe("paginate — countLimit", () => {
  it("stops yielding after the count, even mid-page", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse([1, 2, 3, 4, 5], {
          headers: {
            "content-type": "application/json",
            link: `<https://api.test/p${calls + 1}>; rel="next"`,
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const some = await paginateAll<number>(m, "https://api.test/p1", {
      countLimit: 3,
    })
    expect(some).toEqual([1, 2, 3])
    expect(calls).toBe(1) // didn't fetch page 2
  })
})

describe("paginate — requestLimit", () => {
  it("stops after N requests", async () => {
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

    const some = await paginateAll<number>(m, "https://api.test/p1", {
      requestLimit: 2,
    })
    expect(some).toEqual([1, 2])
    expect(calls).toBe(2)
  })
})

describe("paginate — async iterator can be early-broken", () => {
  it("breaking the for-await loop stops further requests", async () => {
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
      if (items.length >= 2) break
    }

    expect(items).toEqual([1, 2])
    expect(calls).toBe(2)
  })
})
