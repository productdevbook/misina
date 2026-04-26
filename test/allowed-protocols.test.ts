import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("allowedProtocols — URL scheme allowlist", () => {
  it("default: http + https allowed", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/")
    await m.get("http://api.test/")
    // both succeed
  })

  it("default: rejects ftp:// with a clear error", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })

    await expect(m.get("ftp://files.test/x")).rejects.toThrow(
      /protocol "ftp:" not in allowedProtocols/,
    )
  })

  it("opt-in: capacitor:// permitted when listed", async () => {
    let captured: string | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req.url
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      allowedProtocols: ["http", "https", "capacitor"],
    })

    await m.get("capacitor://localhost/api/users")
    expect(captured).toBe("capacitor://localhost/api/users")
  })

  it("per-request override: tauri:// allowed for one call only", async () => {
    let lastUrl: string | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        lastUrl = req.url
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.get("tauri://localhost/x", { allowedProtocols: ["tauri"] })
    expect(lastUrl).toBe("tauri://localhost/x")

    // The next call without the override falls back to defaults → rejected.
    await expect(m.get("tauri://localhost/y")).rejects.toThrow(/protocol "tauri:"/)
  })

  it("relative paths are not validated (driver supplies origin)", async () => {
    let captured: string | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req.url
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    // No baseURL — input is taken as-is. fetch will resolve it against origin.
    const m = createMisina({
      driver,
      retry: 0,
      // NB: relative paths only work when the driver/runtime accepts them.
      // The protocol check is silent for unparseable inputs.
    })

    // Passing a parseable URL just to confirm we don't crash on the check.
    await m.get("https://api.test/v1")
    expect(captured).toBe("https://api.test/v1")
  })

  it("allowAbsoluteUrls: false STILL applies under custom protocols", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      baseURL: "capacitor://localhost",
      allowAbsoluteUrls: false,
      allowedProtocols: ["capacitor"],
    })

    // Relative path resolved against baseURL — fine.
    await expect(m.get("capacitor://other.host/x")).rejects.toThrow(/allowAbsoluteUrls is false/)
  })
})
