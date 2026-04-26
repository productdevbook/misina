/**
 * Cloudflare Workers `cf` RequestInit augmentation.
 *
 * Importing this module adds a typed `cf` field to `MisinaOptions` via
 * augmentation of `MisinaRuntimeOptions`. The value is passed through to
 * the underlying `fetch` so the workerd runtime can act on it.
 *
 * @example
 * ```ts
 * import "misina/runtime/cloudflare"
 *
 * await api.get("/asset", { cf: { cacheTtl: 86400, cacheEverything: true } })
 * ```
 *
 * Reference: https://developers.cloudflare.com/workers/runtime-apis/request/
 */

export interface CloudflareImageOptions {
  fit?: "scale-down" | "contain" | "cover" | "crop" | "pad"
  width?: number
  height?: number
  quality?: number
  format?: "auto" | "avif" | "webp" | "json" | "jpeg" | "png" | "gif"
  dpr?: number
  gravity?: "auto" | "left" | "right" | "top" | "bottom" | { x: number; y: number }
  metadata?: "keep" | "copyright" | "none"
  background?: string
  brightness?: number
  contrast?: number
  gamma?: number
  rotate?: 90 | 180 | 270
  sharpen?: number
  trim?: { top?: number; right?: number; bottom?: number; left?: number }
  anim?: boolean
  blur?: number
  border?: { color: string; width?: number }
  compression?: "fast"
}

export interface CloudflareRequestProperties {
  cacheTtl?: number
  cacheKey?: string
  cacheEverything?: boolean
  cacheTtlByStatus?: Record<string, number>
  scrapeShield?: boolean
  apps?: boolean
  minify?: { javascript?: boolean; css?: boolean; html?: boolean }
  mirage?: boolean
  polish?: "lossy" | "lossless" | "off"
  image?: CloudflareImageOptions
  resolveOverride?: string
}

declare module "../../types.ts" {
  interface MisinaRuntimeOptions {
    /**
     * Cloudflare Workers `cf` property bag forwarded to `fetch`. Available
     * after `import "misina/runtime/cloudflare"`.
     */
    cf?: CloudflareRequestProperties
  }
}

// Materialize a value so the module has a non-empty runtime export. Helps
// some bundlers preserve the file even when it's imported only for its
// side effect (the augmentation above).
export const CLOUDFLARE_RUNTIME_AUGMENTED = true
