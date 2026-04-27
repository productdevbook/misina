#!/usr/bin/env node
// Compare two bench JSON dumps (mitata `format: 'json'` output) and
// print a markdown summary suitable for posting as a PR comment.
//
// Usage:
//   node bench/compare.mjs <base.json> <head.json>
//
// If base.json is missing or unreadable (e.g. the PR introduces a
// breaking API change and the harness couldn't run against base),
// we degrade to a head-only table so the comment still appears.
//
// Exits 0 always — informational regression catcher, not a gate.

import { readFile, stat } from "node:fs/promises"

const [, , basePath, headPath] = process.argv
if (!basePath || !headPath) {
  console.error("usage: node bench/compare.mjs <base.json> <head.json>")
  process.exit(2)
}

async function loadOrNull(path) {
  try {
    await stat(path)
    const raw = await readFile(path, "utf8")
    if (!raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const [base, head] = await Promise.all([loadOrNull(basePath), loadOrNull(headPath)])
if (!head) {
  console.error("compare: head bench JSON missing or empty")
  process.exit(2)
}

// mitata JSON shape:
//   { layout: [{ name }, ...], benchmarks: [{ alias, group, runs: [{ stats: { avg, p99, ... } }] }] }
// `group` is an index into `layout`; the human-readable group name lives
// at `layout[group].name`. `alias` is the per-bench name.
function flatten(dump) {
  const out = new Map()
  const layout = dump.layout ?? []
  for (const benchmark of dump.benchmarks ?? []) {
    const groupName = layout[benchmark.group]?.name ?? "ungrouped"
    const stats = benchmark.runs?.[0]?.stats
    if (!stats) continue
    out.set(`${groupName} :: ${benchmark.alias}`, { avg: stats.avg, p99: stats.p99 })
  }
  return out
}

const baseMap = base ? flatten(base) : new Map()
const headMap = flatten(head)

const rows = []
for (const [key, headStats] of headMap) {
  const baseStats = baseMap.get(key)
  if (!baseStats) {
    rows.push({ key, baseAvg: null, headAvg: headStats.avg, deltaPct: null, isNew: true })
    continue
  }
  const deltaPct = ((headStats.avg - baseStats.avg) / baseStats.avg) * 100
  rows.push({
    key,
    baseAvg: baseStats.avg,
    headAvg: headStats.avg,
    deltaPct,
    isNew: false,
  })
}

// Sort: regressions worst-first, then improvements, then unchanged.
rows.sort((a, b) => {
  const av = a.deltaPct ?? -Infinity
  const bv = b.deltaPct ?? -Infinity
  return bv - av
})

function formatTime(ns) {
  if (ns == null) return "—"
  if (ns < 1_000) return `${ns.toFixed(1)} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`
  return `${(ns / 1_000_000_000).toFixed(2)} s`
}

function formatDelta(pct) {
  if (pct == null) return "**new**"
  const sign = pct > 0 ? "+" : ""
  const emoji = pct > 5 ? "🔴" : pct < -5 ? "🟢" : "·"
  return `${emoji} ${sign}${pct.toFixed(1)}%`
}

const misinaRegressions = rows.filter(
  (r) =>
    !r.isNew && r.deltaPct !== null && r.deltaPct > 5 && r.key.toLowerCase().includes("misina"),
)

const lines = []
lines.push("## Bench results")
lines.push("")
if (!base) {
  lines.push("> ℹ️ Couldn't bench base — head numbers shown without comparison.")
} else if (misinaRegressions.length > 0) {
  lines.push(`> ⚠️ **${misinaRegressions.length} misina row(s) >5% slower than base.**`)
} else {
  lines.push("> ✅ No misina row regressed >5% vs base.")
}
lines.push("")
lines.push("| benchmark | base avg | head avg | Δ |")
lines.push("|---|---:|---:|---:|")
for (const row of rows) {
  lines.push(
    `| ${row.key} | ${formatTime(row.baseAvg)} | ${formatTime(row.headAvg)} | ${formatDelta(row.deltaPct)} |`,
  )
}
lines.push("")
lines.push(
  "<sub>Local Node HTTP server, Apple-class GitHub runner. Numbers fluctuate ±2-3% from runner heat alone — only sustained >5% deltas are signal.</sub>",
)

console.log(lines.join("\n"))
