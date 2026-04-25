export class MisinaError extends Error {
  override readonly name: string = "MisinaError"

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined)

    // V8-only API — present in Node, Bun, Cloudflare Workers, Deno.
    // Absent in Safari/Firefox; the conditional is the lowest-cost
    // way to keep cross-runtime stacks clean without a build flag.
    if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      ;(Error as { captureStackTrace: (target: object, ctor: Function) => void }).captureStackTrace(
        this,
        new.target,
      )
    }
  }
}
