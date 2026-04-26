/**
 * RFC 9651 Structured Field Values parser. Internal use; not exported from
 * the public surface yet. Used by Cache-Status (RFC 9211), Repr-Digest /
 * Content-Digest (RFC 9530), and other SF-based headers.
 *
 * Implements parsers for the three top-level types: Item, List, Dictionary.
 * Returns null on parse failure (no exceptions in the hot path).
 */

export type SfBareItem = number | string | boolean | { token: string } | Uint8Array
export type SfParams = Record<string, SfBareItem>
export type SfItem = { value: SfBareItem; params: SfParams }
export type SfInnerList = { value: SfItem[]; params: SfParams }
export type SfListMember = SfItem | SfInnerList
export type SfDict = Record<string, SfItem | SfInnerList>

class Cursor {
  constructor(
    public input: string,
    public pos: number = 0,
  ) {}
  peek(): string {
    return this.input[this.pos] ?? ""
  }
  consume(): string {
    return this.input[this.pos++] ?? ""
  }
  eof(): boolean {
    return this.pos >= this.input.length
  }
  skipSp(): void {
    while (!this.eof() && this.input[this.pos] === " ") this.pos++
  }
  skipOws(): void {
    while (!this.eof() && (this.input[this.pos] === " " || this.input[this.pos] === "\t"))
      this.pos++
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9"
}
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
}
function isLcAlpha(c: string): boolean {
  return c >= "a" && c <= "z"
}
function isTokenStart(c: string): boolean {
  return isAlpha(c) || c === "*"
}
function isTokenChar(c: string): boolean {
  return isAlpha(c) || isDigit(c) || "!#$%&'*+-.^_`|~:/".includes(c)
}
function isKeyStart(c: string): boolean {
  return isLcAlpha(c) || c === "*"
}
function isKeyChar(c: string): boolean {
  return isLcAlpha(c) || isDigit(c) || c === "_" || c === "-" || c === "." || c === "*"
}

function parseNumber(c: Cursor): number | null {
  let sign = 1
  if (c.peek() === "-") {
    c.consume()
    sign = -1
  }
  if (!isDigit(c.peek())) return null
  let intPart = ""
  while (!c.eof() && isDigit(c.peek())) intPart += c.consume()
  if (intPart.length === 0) return null
  if (c.peek() !== ".") {
    if (intPart.length > 15) return null
    return sign * Number(intPart)
  }
  // decimal
  if (intPart.length > 12) return null
  c.consume() // .
  let frac = ""
  while (!c.eof() && isDigit(c.peek())) frac += c.consume()
  if (frac.length === 0 || frac.length > 3) return null
  return sign * Number(intPart + "." + frac)
}

function parseString(c: Cursor): string | null {
  if (c.consume() !== '"') return null
  let out = ""
  while (!c.eof()) {
    const ch = c.consume()
    if (ch === "\\") {
      const next = c.consume()
      if (next !== '"' && next !== "\\") return null
      out += next
    } else if (ch === '"') {
      return out
    } else {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code >= 0x7f) return null
      out += ch
    }
  }
  return null
}

function parseToken(c: Cursor): { token: string } | null {
  if (!isTokenStart(c.peek())) return null
  let s = c.consume()
  while (!c.eof() && isTokenChar(c.peek())) s += c.consume()
  return { token: s }
}

function parseByteSequence(c: Cursor): Uint8Array | null {
  if (c.consume() !== ":") return null
  let b64 = ""
  while (!c.eof() && c.peek() !== ":") b64 += c.consume()
  if (c.consume() !== ":") return null
  try {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    return u8
  } catch {
    return null
  }
}

function parseBoolean(c: Cursor): boolean | null {
  if (c.consume() !== "?") return null
  const ch = c.consume()
  if (ch === "1") return true
  if (ch === "0") return false
  return null
}

function parseBareItem(c: Cursor): SfBareItem | null {
  const ch = c.peek()
  if (ch === "-" || isDigit(ch)) return parseNumber(c)
  if (ch === '"') return parseString(c)
  if (ch === ":") return parseByteSequence(c)
  if (ch === "?") return parseBoolean(c)
  if (isTokenStart(ch)) return parseToken(c)
  return null
}

function parseKey(c: Cursor): string | null {
  if (!isKeyStart(c.peek())) return null
  let s = c.consume()
  while (!c.eof() && isKeyChar(c.peek())) s += c.consume()
  return s
}

function parseParameters(c: Cursor): SfParams | null {
  const params: SfParams = {}
  while (!c.eof() && c.peek() === ";") {
    c.consume()
    c.skipSp()
    const key = parseKey(c)
    if (key === null) return null
    let value: SfBareItem = true
    if (c.peek() === "=") {
      c.consume()
      const v = parseBareItem(c)
      if (v === null) return null
      value = v
    }
    params[key] = value
  }
  return params
}

function parseItemMember(c: Cursor): SfItem | null {
  const value = parseBareItem(c)
  if (value === null) return null
  const params = parseParameters(c)
  if (params === null) return null
  return { value, params }
}

function parseInnerList(c: Cursor): SfInnerList | null {
  if (c.consume() !== "(") return null
  const items: SfItem[] = []
  while (!c.eof()) {
    c.skipSp()
    if (c.peek() === ")") {
      c.consume()
      const params = parseParameters(c)
      if (params === null) return null
      return { value: items, params }
    }
    const item = parseItemMember(c)
    if (item === null) return null
    items.push(item)
    if (c.peek() !== " " && c.peek() !== ")") return null
  }
  return null
}

function parseListMember(c: Cursor): SfListMember | null {
  if (c.peek() === "(") return parseInnerList(c)
  return parseItemMember(c)
}

export function parseSfItem(input: string): SfItem | null {
  const c = new Cursor(input)
  c.skipSp()
  const item = parseItemMember(c)
  if (item === null) return null
  c.skipSp()
  if (!c.eof()) return null
  return item
}

export function parseSfList(input: string): SfListMember[] | null {
  const c = new Cursor(input)
  c.skipSp()
  if (c.eof()) return []
  const out: SfListMember[] = []
  for (;;) {
    const m = parseListMember(c)
    if (m === null) return null
    out.push(m)
    c.skipOws()
    if (c.eof()) return out
    if (c.consume() !== ",") return null
    c.skipOws()
    if (c.eof()) return null // trailing comma
  }
}

export function parseSfDict(input: string): SfDict | null {
  const c = new Cursor(input)
  c.skipSp()
  if (c.eof()) return {}
  const out: SfDict = {}
  for (;;) {
    const key = parseKey(c)
    if (key === null) return null
    let member: SfItem | SfInnerList
    if (c.peek() === "=") {
      c.consume()
      const m = parseListMember(c)
      if (m === null) return null
      member = m
    } else {
      const params = parseParameters(c)
      if (params === null) return null
      member = { value: true, params }
    }
    out[key] = member
    c.skipOws()
    if (c.eof()) return out
    if (c.consume() !== ",") return null
    c.skipOws()
    if (c.eof()) return null
  }
}
