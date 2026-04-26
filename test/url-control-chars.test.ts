import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

const noopDriver = {
  name: "noop",
  request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
}

describe("URL control-char guard", () => {
  it("rejects \\r in baseURL", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com\r" })
    await expect(m.get("/x")).rejects.toThrow(/CR\/LF\/NUL/)
  })

  it("rejects \\n in baseURL", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com\n" })
    await expect(m.get("/x")).rejects.toThrow(/CR\/LF\/NUL/)
  })

  it("rejects \\0 in baseURL", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com\0" })
    await expect(m.get("/x")).rejects.toThrow(/CR\/LF\/NUL/)
  })

  it("rejects \\r\\n in path", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com" })
    await expect(m.get("/path\r\nwith-newline")).rejects.toThrow(/CR\/LF\/NUL/)
  })

  it("rejects \\0 in absolute URL input", async () => {
    const m = createMisina({ driver: noopDriver })
    await expect(m.get("https://api.example.com/x\0")).rejects.toThrow(/CR\/LF\/NUL/)
  })

  it("error mentions which side: baseURL or input", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://x.com\r" })
    await expect(m.get("/y")).rejects.toThrow(/baseURL/)

    const m2 = createMisina({ driver: noopDriver, baseURL: "https://x.com" })
    await expect(m2.get("/y\r")).rejects.toThrow(/input/)
  })

  it("permits normal URLs", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com" })
    await expect(m.get("/users/42?q=hello")).resolves.toBeDefined()
  })

  it("permits %-encoded sequences (those are not raw CR/LF)", async () => {
    const m = createMisina({ driver: noopDriver, baseURL: "https://api.example.com" })
    await expect(m.get("/path%0A")).resolves.toBeDefined()
  })
})
