import { describe, expect, it } from "vitest"
import { createMisinaTyped } from "../src/index.ts"
import type { OpenApiEndpoints } from "../src/openapi/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

// ─── synthesized openapi-typescript-shaped fixture ────────────────────────
// Mirrors what `openapi-typescript` produces for a small OpenAPI spec.
interface User {
  id: string
  name: string
}
interface NewUser {
  name: string
}

type Paths = {
  "/users/{id}": {
    get: {
      parameters: { path: { id: string } }
      responses: {
        200: { content: { "application/json": User } }
        404: { content: { "application/json": { error: string } } }
      }
    }
    delete: {
      parameters: { path: { id: string } }
      responses: { 204: never }
    }
  }
  "/users": {
    get: {
      parameters: { query: { page?: number; q?: string } }
      responses: { 200: { content: { "application/json": User[] } } }
    }
    post: {
      requestBody: { content: { "application/json": NewUser } }
      responses: { 201: { content: { "application/json": User } } }
    }
  }
}

// ─── adapter compiles to the expected EndpointsMap shape ──────────────────
type Endpoints = OpenApiEndpoints<Paths>

// Per-field type proofs. If any of these break, the assignment fails to compile.
type GetUser = Endpoints["GET /users/{id}"]
type ListUsers = Endpoints["GET /users"]
type CreateUser = Endpoints["POST /users"]
type DeleteUser = Endpoints["DELETE /users/{id}"]

const _getUserParams: Extends<GetUser, { params: { id: string } }> = true
const _getUserResponse: Extends<GetUser, { response: User }> = true
const _listUsersQuery: Extends<ListUsers, { query: { page?: number; q?: string } }> = true
const _listUsersResponse: Extends<ListUsers, { response: User[] }> = true
const _createUserBody: Extends<CreateUser, { body: NewUser }> = true
const _createUserResponse: Extends<CreateUser, { response: User }> = true
const _deleteUserParams: Extends<DeleteUser, { params: { id: string } }> = true

void _getUserParams
void _getUserResponse
void _listUsersQuery
void _listUsersResponse
void _createUserBody
void _createUserResponse
void _deleteUserParams

type Extends<A, B> = A extends B ? true : false

// ─── runtime tests — the adapter is type-only, but createMisinaTyped works ─
describe("misina/openapi (#35) — runtime", () => {
  it("substitutes path params from openapi-style {id} templates", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ id: "42", name: "Octocat" }), {
        headers: { "content-type": "application/json" },
      }),
    })

    const api = createMisinaTyped<Endpoints>({
      driver,
      retry: 0,
      baseURL: "https://api.test",
    })
    const res = await api.get("/users/{id}", { params: { id: "42" } })

    expect(res.data).toEqual({ id: "42", name: "Octocat" })
  })

  it("posts a typed body and gets a typed response", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ id: "100", name: "New" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    })

    const api = createMisinaTyped<Endpoints>({
      driver,
      retry: 0,
      baseURL: "https://api.test",
    })
    const res = await api.post("/users", { body: { name: "New" } })

    expect(res.data.name).toBe("New")
  })
})
