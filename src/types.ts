export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

export interface MisinaRequest {
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body?: unknown
  signal?: AbortSignal
}

export interface MisinaResponse<T = unknown> {
  data: T
  status: number
  headers: Record<string, string>
  raw: Response
}

export interface MisinaOptions {
  baseURL?: string
  headers?: Record<string, string>
  timeout?: number
  retry?: number
  fetch?: typeof globalThis.fetch
}

export interface Misina {
  request: <T = unknown>(input: string, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
  get: <T = unknown>(url: string, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
  post: <T = unknown>(url: string, body?: unknown, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
  put: <T = unknown>(url: string, body?: unknown, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
  patch: <T = unknown>(url: string, body?: unknown, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
  delete: <T = unknown>(url: string, init?: Partial<MisinaRequest>) => Promise<MisinaResponse<T>>
}
