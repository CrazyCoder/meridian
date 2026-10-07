/**
 * The Meridian favicon, served at /telemetry/icon.svg by both the Claude and
 * the Antigravity server so every page's `<link rel="icon">` resolves.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

export const ICON_PATH = "/telemetry/icon.svg"

/**
 * The package root is two levels above this file when it runs from
 * src/telemetry/, but one level above it once bundled, because the build
 * flattens every module into chunks directly under dist/. Resolving only the
 * source layout left the published package without an icon.
 */
export function findIconFile(moduleDir: string): string | null {
  for (const up of [["..", ".."], [".."]]) {
    const candidate = resolve(moduleDir, ...up, "assets", "icon.svg")
    if (existsSync(candidate)) return candidate
  }
  return null
}

const iconFile = findIconFile(dirname(fileURLToPath(import.meta.url)))
const iconSvg = iconFile ? readFileSync(iconFile, "utf-8") : null

export function iconResponse(): Response | null {
  if (!iconSvg) return null
  return new Response(iconSvg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
  })
}
