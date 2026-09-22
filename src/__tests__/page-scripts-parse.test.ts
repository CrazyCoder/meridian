import { describe, expect, test } from "bun:test"
import { dashboardHtml } from "../telemetry/dashboard"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"
import { providerPageHtml } from "../telemetry/providerPage"
import { settingsPageHtml } from "../telemetry/settingsPage"

// Each page ships its behaviour as an inline <script> inside a TypeScript
// template literal. Neither tsc nor the bundler looks inside that string, so a
// script that fails to parse compiles, builds and serves a page that does
// nothing. Parsing it here is the only check that can see it.
const pages = { dashboardHtml, landingHtml, profilePageHtml, providerPageHtml, settingsPageHtml }

describe("inline page scripts parse", () => {
  for (const [name, html] of Object.entries(pages)) {
    test(name, () => {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? "")
      expect(scripts.length).toBeGreaterThan(0)
      for (const script of scripts) expect(() => new Function(script)).not.toThrow()
    })
  }
})
