/**
 * RFC 9457 problem+json — auto-parsed onto HTTPError.problem.
 *
 * When a server emits `Content-Type: application/problem+json` (Spring 6,
 * .NET, Cloudflare 1xxx errors, many others), misina lifts the structured
 * shape onto `err.problem` and includes `detail` in the error message.
 *
 * Run: pnpm dlx tsx examples/09-problem-details.ts
 */
import { createMisina, HTTPError, isHTTPError } from "../src/index.ts"

// Local mock driver so we don't depend on a server emitting problem+json.
const driver = {
  name: "demo",
  request: async () =>
    new Response(
      JSON.stringify({
        type: "https://example.test/errors/insufficient-funds",
        title: "Insufficient Funds",
        status: 402,
        detail: "Your account balance is $0.00.",
        instance: "/transactions/abc-123",
        balance: 0,
      }),
      {
        status: 402,
        headers: { "content-type": "application/problem+json" },
      },
    ),
}

const api = createMisina({ driver, retry: 0 })

try {
  await api.post("https://api.test/charge", { amount: 100 })
} catch (err) {
  if (isHTTPError(err)) {
    // err.message already includes problem.detail:
    //   HTTPError: Request failed with status 402 : Your account balance is $0.00.
    console.log("message :", err.message)

    // Structured access:
    console.log("type    :", err.problem?.type)
    console.log("title   :", err.problem?.title)
    console.log("status  :", err.problem?.status)
    console.log("detail  :", err.problem?.detail)
    console.log("instance:", err.problem?.instance)

    // Extension fields are preserved:
    console.log("balance :", err.problem?.balance)
  }
}

// Type-narrow with the discriminator:
function handle(err: HTTPError): void {
  if (err.problem?.type === "https://example.test/errors/insufficient-funds") {
    console.log("→ surfacing top-up flow to the user")
  }
}
void handle
