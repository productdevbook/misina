import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import type { SentryHub } from "../src/sentry/index.ts"
import { sentry } from "../src/sentry/index.ts"

type CaptureRecord = { error: unknown; context: Record<string, unknown> | undefined }
type BreadcrumbRecord = { category?: string; message?: string; data?: Record<string, unknown> }

function fakeSentry(): SentryHub & {
  exceptions: CaptureRecord[]
  breadcrumbs: BreadcrumbRecord[]
} {
  const exceptions: CaptureRecord[] = []
  const breadcrumbs: BreadcrumbRecord[] = []
  return {
    exceptions,
    breadcrumbs,
    captureException(error, context) {
      exceptions.push({ error, context })
      return "id"
    },
    addBreadcrumb(crumb) {
      breadcrumbs.push(crumb as BreadcrumbRecord)
    },
  }
}

describe("sentry — captureException", () => {
  it("captures HTTPError with request context + status", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () =>
        new Response("nope", {
          status: 500,
          headers: { "x-request-id": "req_1" },
        }),
    }
    const m = createMisina({ driver, retry: 0, use: [sentry({ Sentry })] })
    await expect(m.get("https://x.test/users/42")).rejects.toBeDefined()
    expect(Sentry.exceptions).toHaveLength(1)
    const ctx = Sentry.exceptions[0]?.context as {
      contexts?: { request?: { method?: string; url?: string }; response?: { status?: number } }
      tags?: Record<string, string>
    }
    expect(ctx.contexts?.request?.method).toBe("GET")
    expect(ctx.contexts?.request?.url).toBe("https://x.test/users/42")
    expect(ctx.contexts?.response?.status).toBe(500)
    expect(ctx.tags?.request_id).toBe("req_1")
  })

  it("redacts authorization + cookie + proxy-authorization by default", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("err", { status: 500 }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-public": "ok",
      },
      use: [sentry({ Sentry })],
    })
    await expect(m.get("https://x.test/")).rejects.toBeDefined()
    const headers = (
      Sentry.exceptions[0]?.context as {
        contexts?: { request?: { headers?: Record<string, string> } }
      }
    )?.contexts?.request?.headers
    expect(headers?.authorization).toBe("[redacted]")
    expect(headers?.cookie).toBe("[redacted]")
    expect(headers?.["x-public"]).toBe("ok")
  })

  it("default level skips 4xx (client errors)", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("not found", { status: 404 }),
    }
    const m = createMisina({ driver, retry: 0, use: [sentry({ Sentry })] })
    await expect(m.get("https://x.test/")).rejects.toBeDefined()
    expect(Sentry.exceptions).toHaveLength(0)
  })

  it("captureLevel: 'all' captures 4xx", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("not found", { status: 404 }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [sentry({ Sentry, captureLevel: "all" })],
    })
    await expect(m.get("https://x.test/")).rejects.toBeDefined()
    expect(Sentry.exceptions).toHaveLength(1)
  })

  it("captureLevel: '5xx' skips network errors", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => {
        throw new TypeError("fetch failed")
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [sentry({ Sentry, captureLevel: "5xx" })],
    })
    await expect(m.get("https://x.test/")).rejects.toBeDefined()
    expect(Sentry.exceptions).toHaveLength(0)
  })

  it("custom redactHeaders extends the default redact list", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("err", { status: 500 }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      headers: { "x-api-key": "secret" },
      use: [sentry({ Sentry, redactHeaders: ["x-api-key"] })],
    })
    await expect(m.get("https://x.test/")).rejects.toBeDefined()
    const headers = (
      Sentry.exceptions[0]?.context as {
        contexts?: { request?: { headers?: Record<string, string> } }
      }
    )?.contexts?.request?.headers
    expect(headers?.["x-api-key"]).toBe("[redacted]")
  })
})

describe("sentry — successBreadcrumb", () => {
  it("adds a breadcrumb on successful request when enabled", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [sentry({ Sentry, successBreadcrumb: true })],
    })
    await m.get("https://x.test/")
    expect(Sentry.breadcrumbs).toHaveLength(1)
    expect(Sentry.breadcrumbs[0]?.category).toBe("fetch")
    expect((Sentry.breadcrumbs[0]?.data as { status?: number })?.status).toBe(200)
  })

  it("disabled by default", async () => {
    const Sentry = fakeSentry()
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0, use: [sentry({ Sentry })] })
    await m.get("https://x.test/")
    expect(Sentry.breadcrumbs).toHaveLength(0)
  })
})
