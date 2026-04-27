/**
 * Type contract pinning for the public API. Catches accidental contract
 * breaks at typecheck time before they reach a release. Each block
 * targets one shape we don't want to change without a major version
 * bump.
 *
 * `expectTypeOf` is purely structural — failures show up as TS errors
 * during `tsgo --noEmit`, not as vitest assertions.
 */

import { describe, expectTypeOf, it } from "vitest"
import { bearer } from "../src/auth/index.ts"
import { breaker, type BreakerHandle } from "../src/breaker/index.ts"
import {
  createMisina,
  type HTTPError,
  isHTTPError,
  isMisinaError,
  isNetworkError,
  isTimeoutError,
  type Misina,
  type MisinaPlugin,
  type MisinaResponse,
  type MisinaResponsePromise,
  type MisinaResult,
} from "../src/index.ts"
import { tracing } from "../src/tracing/index.ts"

describe("createMisina return type", () => {
  it("returns Misina for an empty options object", () => {
    const api = createMisina()
    expectTypeOf(api).toEqualTypeOf<Misina>()
  })

  it("returns Misina with no plugins", () => {
    const api = createMisina({ baseURL: "https://api.test" })
    expectTypeOf(api).toEqualTypeOf<Misina>()
  })

  it("hook-only plugin (TExt = {}) does not widen the surface", () => {
    const api = createMisina({ use: [bearer("token")] })
    expectTypeOf(api).toEqualTypeOf<Misina>()
  })

  it("extend-slot plugin contributes its TExt", () => {
    const api = createMisina({ use: [breaker()] })
    expectTypeOf(api).toEqualTypeOf<Misina & { breaker: BreakerHandle }>()
    expectTypeOf(api.breaker).toEqualTypeOf<BreakerHandle>()
    expectTypeOf(api.breaker.state).toBeFunction()
  })

  it("multiple plugins intersect their TExt left-to-right", () => {
    const api = createMisina({ use: [bearer("t"), tracing(), breaker()] })
    expectTypeOf(api).toEqualTypeOf<Misina & {} & {} & { breaker: BreakerHandle }>()
    // Even with three plugins, all base methods stay reachable + typed.
    expectTypeOf(api.get).toBeFunction()
    expectTypeOf(api.breaker).toEqualTypeOf<BreakerHandle>()
  })
})

describe("HTTP method generic flow", () => {
  const api = createMisina()

  // Type-only — no calls. Calling api.get(...) here would fire a real
  // unhandled fetch promise and pollute the run.
  it("get<T> returns MisinaResponsePromise<T>", () => {
    expectTypeOf<ReturnType<typeof api.get<{ id: string }>>>().toEqualTypeOf<
      MisinaResponsePromise<{ id: string }>
    >()
  })

  it("awaited get<T> resolves to MisinaResponse<T>", () => {
    type T = { id: string; name: string }
    expectTypeOf<Awaited<ReturnType<typeof api.get<T>>>>().toEqualTypeOf<MisinaResponse<T>>()
  })

  it("post<T> accepts an unknown body and returns MisinaResponsePromise<T>", () => {
    expectTypeOf(api.post<{ ok: boolean }>)
      .parameter(0)
      .toEqualTypeOf<string>()
    expectTypeOf<ReturnType<typeof api.post<{ ok: boolean }>>>().toEqualTypeOf<
      MisinaResponsePromise<{ ok: boolean }>
    >()
  })

  it("default T = unknown when not specified", () => {
    expectTypeOf<Awaited<ReturnType<typeof api.get>>>().toEqualTypeOf<MisinaResponse<unknown>>()
  })
})

describe("safe() — discriminated MisinaResult flow", () => {
  const api = createMisina()

  it("safe.get<T, E> resolves to MisinaResult<T, E>", async () => {
    type T = { id: string }
    type E = { code: string }
    expectTypeOf<Awaited<ReturnType<typeof api.safe.get<T, E>>>>().toEqualTypeOf<
      MisinaResult<T, E>
    >()
  })

  it("MisinaResult is a discriminated union by `ok`", () => {
    type R = MisinaResult<{ id: string }, { code: string }>
    type Ok = Extract<R, { ok: true }>
    type Err = Extract<R, { ok: false }>
    expectTypeOf<Ok["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Err["error"]>().toEqualTypeOf<HTTPError<{ code: string }> | Error>()
  })
})

describe("MisinaPlugin shape", () => {
  it("default TExt is the empty object literal", () => {
    type Default = MisinaPlugin
    type WithDefault = MisinaPlugin<{}>
    expectTypeOf<Default>().toEqualTypeOf<WithDefault>()
  })

  it("TExt accepts plain object literals", () => {
    type Surface = { breaker: BreakerHandle }
    expectTypeOf<MisinaPlugin<Surface>>().toMatchTypeOf<{
      extend?: (m: Misina) => Misina & Surface
    }>()
  })
})

describe("error narrowing — type guards", () => {
  it("isHTTPError narrows unknown to HTTPError<T>", () => {
    const err: unknown = new Error()
    if (isHTTPError<{ code: string }>(err)) {
      expectTypeOf(err).toEqualTypeOf<HTTPError<{ code: string }>>()
      expectTypeOf(err.status).toEqualTypeOf<number>()
      expectTypeOf(err.data).toEqualTypeOf<{ code: string }>()
    }
  })

  it("isTimeoutError, isNetworkError, isMisinaError all narrow unknown", () => {
    const err: unknown = new Error()
    expectTypeOf(isTimeoutError).toBeFunction()
    expectTypeOf(isNetworkError).toBeFunction()
    expectTypeOf(isMisinaError).toBeFunction()
    if (isMisinaError(err)) {
      expectTypeOf(err.message).toEqualTypeOf<string>()
    }
  })
})

describe("extend() preserves the base Misina shape", () => {
  it("extend produces a plain Misina, not the plugin-extended client", () => {
    // The extend() child does NOT carry plugin TExt — plugins are
    // resolved at the createMisina root call only. This test pins that
    // contract.
    const api = createMisina({ use: [breaker()] })
    expectTypeOf(api).toEqualTypeOf<Misina & { breaker: BreakerHandle }>()
    const child = api.extend({ baseURL: "https://child.test" })
    expectTypeOf(child).toEqualTypeOf<Misina>()
  })
})
