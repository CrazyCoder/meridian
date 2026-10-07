import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findIconFile } from "../telemetry/icon"
import { createTelemetryRoutes } from "../telemetry/routes"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function packageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-icon-"))
  roots.push(root)
  mkdirSync(join(root, "assets"))
  mkdirSync(join(root, "dist"))
  mkdirSync(join(root, "src", "telemetry"), { recursive: true })
  writeFileSync(join(root, "assets", "icon.svg"), "<svg/>")
  return root
}

describe("findIconFile", () => {
  test("finds the asset from the source layout", () => {
    const root = packageRoot()
    expect(findIconFile(join(root, "src", "telemetry"))).toBe(join(root, "assets", "icon.svg"))
  })

  test("finds the asset from a bundled chunk directly under dist/", () => {
    const root = packageRoot()
    expect(findIconFile(join(root, "dist"))).toBe(join(root, "assets", "icon.svg"))
  })

  test("reports a missing asset instead of guessing", () => {
    const root = packageRoot()
    rmSync(join(root, "assets"), { recursive: true })
    expect(findIconFile(join(root, "dist"))).toBeNull()
  })
})

describe("GET /telemetry/icon.svg", () => {
  test("serves the packaged SVG", async () => {
    const response = await createTelemetryRoutes().request("/icon.svg")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/svg+xml")
    expect(await response.text()).toContain("<svg")
  })
})
