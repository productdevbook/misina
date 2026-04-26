import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { GraphqlAggregateError, withGraphql } from "../src/graphql/index.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("withGraphql — basic POST query/mutate", () => {
  it("query() sends the canonical envelope and returns data", async () => {
    let observedBody: string | null = null
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        observedBody = await req.text()
        return jsonResponse({ data: { user: { id: "42", name: "Ada" } } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m)
    const data = await gql.query<{ user: { id: string; name: string } }>(
      "query Get($id: ID!){user(id:$id){id name}}",
      { id: "42" },
      { operationName: "Get" },
    )
    expect(data.user.name).toBe("Ada")
    const parsed = JSON.parse(observedBody!)
    expect(parsed.query).toContain("query Get")
    expect(parsed.variables).toEqual({ id: "42" })
    expect(parsed.operationName).toBe("Get")
  })

  it("mutate() always uses POST (no GET fallback)", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.method)
        return jsonResponse({ data: { ok: true } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m, { getFallbackBelow: 99_999 }) // very high
    await gql.mutate("mutation Foo{foo}")
    expect(seen).toEqual(["POST"])
  })

  it("errors[] in response throws GraphqlAggregateError preserving data", async () => {
    const driver = {
      name: "x",
      request: async () =>
        jsonResponse({
          data: { user: null },
          errors: [{ message: "not found", path: ["user"] }],
        }),
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m)
    try {
      await gql.query("{user{id}}")
      expect.fail("should throw")
    } catch (err) {
      expect(err).toBeInstanceOf(GraphqlAggregateError)
      expect((err as GraphqlAggregateError).errors[0]?.message).toBe("not found")
      expect((err as GraphqlAggregateError).data).toEqual({ user: null })
    }
  })
})

describe("withGraphql — APQ", () => {
  it("first attempt sends hash only; PersistedQueryNotFound triggers full retry", async () => {
    const calls: Array<{ envelope: { query?: string; extensions?: unknown } }> = []
    let i = 0
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        i++
        const envelope = JSON.parse(await req.text())
        calls.push({ envelope })
        if (i === 1) {
          return jsonResponse({
            errors: [{ message: "PersistedQueryNotFound" }],
          })
        }
        return jsonResponse({ data: { user: { id: "1" } } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m, { persistedQueries: true })
    const data = await gql.query<{ user: { id: string } }>("{user{id}}")
    expect(data.user.id).toBe("1")
    expect(calls).toHaveLength(2)
    // First call: hash only, no `query` field.
    expect(calls[0]?.envelope.query).toBeUndefined()
    expect(
      (calls[0]?.envelope.extensions as { persistedQuery?: { sha256Hash?: string } })
        ?.persistedQuery?.sha256Hash,
    ).toMatch(/^[0-9a-f]{64}$/)
    // Second call: full query + same hash.
    expect(calls[1]?.envelope.query).toBe("{user{id}}")
  })

  it("APQ extension uses extensions.code === PERSISTED_QUERY_NOT_FOUND too", async () => {
    let i = 0
    const driver = {
      name: "x",
      request: async (): Promise<Response> => {
        i++
        if (i === 1) {
          return jsonResponse({
            errors: [{ message: "x", extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }],
          })
        }
        return jsonResponse({ data: { ok: true } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m, { persistedQueries: true })
    const data = await gql.query<{ ok: boolean }>("{ok}")
    expect(data.ok).toBe(true)
    expect(i).toBe(2)
  })
})

describe("withGraphql — GET fallback", () => {
  it("query under threshold goes via GET", async () => {
    const seen: { method: string; url: string }[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push({ method: req.method, url: req.url })
        return jsonResponse({ data: { ok: true } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m, { getFallbackBelow: 1500 })
    await gql.query("{ok}")
    expect(seen[0]?.method).toBe("GET")
    expect(seen[0]?.url).toContain("query=")
  })

  it("query above threshold falls back to POST", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.method)
        return jsonResponse({ data: { ok: true } })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    const gql = withGraphql(m, { getFallbackBelow: 50 })
    await gql.query(`query A{${"a".repeat(100)}}`)
    expect(seen).toEqual(["POST"])
  })
})
