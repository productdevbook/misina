export class MisinaError extends Error {
  override readonly name: string = "MisinaError"

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined)

    if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      ;(Error as { captureStackTrace: (target: object, ctor: Function) => void }).captureStackTrace(
        this,
        new.target,
      )
    }
  }
}
