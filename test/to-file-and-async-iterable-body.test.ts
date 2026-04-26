import { describe, expect, it } from "vitest"
import { createMisina, toFile } from "../src/index.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()

describe("toFile() — multipart-friendly File factory", () => {
  it("from string", async () => {
    const f = await toFile("hello.txt", "hello world", { type: "text/plain" })
    expect(f).toBeInstanceOf(File)
    expect(f.name).toBe("hello.txt")
    expect(f.type).toBe("text/plain")
    expect(await f.text()).toBe("hello world")
  })

  it("from Uint8Array", async () => {
    const f = await toFile("bytes.bin", enc.encode("xyz"))
    expect(f.type).toBe("application/octet-stream")
    expect(dec.decode(new Uint8Array(await f.arrayBuffer()))).toBe("xyz")
  })

  it("from ArrayBuffer", async () => {
    const buf = new ArrayBuffer(3)
    new Uint8Array(buf).set([0x61, 0x62, 0x63]) // 'abc'
    const f = await toFile("ab.bin", buf)
    expect(dec.decode(new Uint8Array(await f.arrayBuffer()))).toBe("abc")
  })

  it("from Blob preserves contents", async () => {
    const f = await toFile("blob.bin", new Blob(["hi"]))
    expect(await f.text()).toBe("hi")
  })

  it("from ReadableStream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("part-1"))
        controller.enqueue(enc.encode(",part-2"))
        controller.close()
      },
    })
    const f = await toFile("stream.txt", stream, { type: "text/plain" })
    expect(await f.text()).toBe("part-1,part-2")
  })

  it("from async iterable (generator)", async () => {
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode("a")
      yield enc.encode("b")
      yield enc.encode("c")
    }
    const f = await toFile("gen.txt", gen())
    expect(await f.text()).toBe("abc")
  })

  it("honors lastModified option", async () => {
    const t = Date.now() - 60_000
    const f = await toFile("ts.bin", "x", { lastModified: t })
    expect(f.lastModified).toBe(t)
  })
})

describe("body normalization — async iterable becomes ReadableStream", () => {
  it("async generator body is wrapped via ReadableStream.from", async () => {
    let receivedBody = ""
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        receivedBody = await new Response(req.body).text()
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode("alpha-")
      yield enc.encode("beta")
    }
    await m.post("https://x.test/", gen() as unknown, {
      headers: { "content-type": "text/plain" },
    })
    expect(receivedBody).toBe("alpha-beta")
  })
})
