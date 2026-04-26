#!/usr/bin/env node
// Bundle-size budget check (raw bytes, pre-gzip).
// Bump deliberately when a real feature lands.

import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"

const DIST = resolve(process.cwd(), "dist")

const BUDGETS = [
  // Core surface — must stay tight
  { match: (p) => p === "index.mjs", max: 12_000, label: "core" },
  { match: (p) => p === "misina.mjs", max: 22_000, label: "core engine" },

  // Internal helpers
  { match: (p) => /^_[\w-]+\.mjs$/.test(p), max: 6_000, label: "internal" },

  // Subpaths
  { match: (p) => p.startsWith("driver/"), max: 6_000, label: "driver" },
  { match: (p) => p.startsWith("errors/"), max: 4_000, label: "errors" },
  { match: (p) => p.startsWith("stream/"), max: 4_000, label: "stream" },
  { match: (p) => p.startsWith("paginate/"), max: 4_000, label: "paginate" },
  { match: (p) => p.startsWith("dedupe/"), max: 4_000, label: "dedupe" },
  { match: (p) => p.startsWith("cache/"), max: 4_500, label: "cache" },
  { match: (p) => p.startsWith("auth/"), max: 6_000, label: "auth" },
  { match: (p) => p.startsWith("cookie/"), max: 6_000, label: "cookie" },
  { match: (p) => p.startsWith("test/"), max: 6_000, label: "test" },
  { match: (p) => p.startsWith("breaker/"), max: 4_000, label: "breaker" },
  { match: (p) => p.startsWith("poll/"), max: 2_500, label: "poll" },
  { match: (p) => p.startsWith("ratelimit/"), max: 2_500, label: "ratelimit" },
  { match: (p) => p.startsWith("openapi/"), max: 200, label: "openapi (type-only)" },
  { match: (p) => p === "typed.mjs", max: 6_000, label: "typed" },
  { match: (p) => p === "types.mjs", max: 200, label: "types" },
]

async function* walk(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* walk(fullPath, rel)
    } else if (entry.name.endsWith(".mjs")) {
      yield { path: fullPath, rel }
    }
  }
}

const failures = []
const summary = []

for await (const file of walk(DIST)) {
  const { size } = await stat(file.path)
  const budget = BUDGETS.find((b) => b.match(file.rel))
  if (!budget) {
    summary.push({ rel: file.rel, size, max: undefined, label: "unbudgeted", ok: true })
    continue
  }
  const ok = size <= budget.max
  summary.push({ rel: file.rel, size, max: budget.max, label: budget.label, ok })
  if (!ok) failures.push(`${file.rel}  ${size}B  >  ${budget.max}B  (${budget.label})`)
}

summary.sort((a, b) => b.size - a.size)

console.log("\nBundle sizes (raw, pre-gzip):")
console.log("─".repeat(72))
for (const s of summary) {
  const status = s.ok ? "✓" : "✗"
  const pct = s.max ? `${Math.round((s.size / s.max) * 100)}%` : "—"
  console.log(
    `  ${status}  ${s.rel.padEnd(38)} ${String(s.size).padStart(6)}B  ${pct.padStart(4)}  ${s.label}`,
  )
}
console.log("─".repeat(72))

if (failures.length > 0) {
  console.error("\n❌ Bundle budget exceeded:")
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log("\n✅ All bundles within budget.")
