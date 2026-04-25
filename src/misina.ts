import type { HttpMethod, Misina, MisinaOptions, MisinaRequest, MisinaResponse } from "./types.ts"

export function createMisina(options: MisinaOptions = {}): Misina {
  const fetchImpl = options.fetch ?? globalThis.fetch

  async function request<T = unknown>(
    input: string,
    init: Partial<MisinaRequest> = {},
  ): Promise<MisinaResponse<T>> {
    const url = options.baseURL ? new URL(input, options.baseURL).toString() : input
    const headers: Record<string, string> = { ...options.headers, ...init.headers }
    const method: HttpMethod = init.method ?? "GET"

    const body = serializeBody(init.body, headers)

    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: init.signal,
    })

    const data = (await parseBody(res)) as T

    return {
      data,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      raw: res,
    }
  }

  return {
    request,
    get: (url, init) => request(url, { ...init, method: "GET" }),
    post: (url, body, init) => request(url, { ...init, method: "POST", body }),
    put: (url, body, init) => request(url, { ...init, method: "PUT", body }),
    patch: (url, body, init) => request(url, { ...init, method: "PATCH", body }),
    delete: (url, init) => request(url, { ...init, method: "DELETE" }),
  }
}

function serializeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body == null) return undefined
  if (typeof body === "string" || body instanceof FormData || body instanceof Blob) {
    return body as BodyInit
  }
  if (!headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json"
  }
  return JSON.stringify(body)
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) return res.json()
  if (ct.startsWith("text/")) return res.text()
  return res.arrayBuffer()
}
