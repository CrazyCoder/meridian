import { describe, expect, it } from "bun:test"
import { profileBarCss, profileBarHtml, profileBarJs } from "../telemetry/profileBar"

class Element extends EventTarget {
  disabled = false
  hidden = false
  textContent = ""
  className = ""
  title = ""
  attributes = new Map<string, string>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
}

function fixture() {
  const button = new Element(), dot = new Element(), text = new Element(), host = new Element()
  const panel = new Element(), region = new Element()
  const document = Object.assign(new EventTarget(), { getElementById: (id: string) => id === "mhStatusDetails" ? panel : id === "mhStatusWrap" ? region : null })
  // Execute the actual serialized shared-header rendering code. The lightweight
  // elements exercise attributes and updates; they do not model browser layout
  // or the accessibility tree, which remain actual browser/SR acceptance gates.
  const hostStart = profileBarJs.indexOf("var hostLabelView =")
  const statusStart = profileBarJs.indexOf("var statusPillView =")
  expect(hostStart).toBeGreaterThan(0)
  expect(statusStart).toBeGreaterThan(0)
  const start = Math.min(hostStart, statusStart)
  const end = profileBarJs.indexOf("var provChip =", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const controls = new Function("document", "statusPill", "statusDot", "statusText", "hostChip",
    profileBarJs.slice(start, end) + "return { renderHost, renderStatus, statusPillView };")(
      document, button, dot, text, host,
    ) as { renderHost(hostname: unknown): void; renderStatus(view: unknown): void; statusPillView(health: unknown): unknown }
  const render = (health: unknown, generation = 1, currentGeneration = 1) => {
    const callbackStart = profileBarJs.indexOf("if (generation !== healthGeneration) return;")
    const callbackEnd = profileBarJs.indexOf("renderBuild(h.build);", callbackStart)
    new Function("generation", "healthGeneration", "h", "renderHost", "renderStatus", "statusPillView",
      profileBarJs.slice(callbackStart, callbackEnd))(
        generation, currentGeneration, health, controls.renderHost, controls.renderStatus, controls.statusPillView,
      )
  }
  const failHealth = () => {
    const catchStart = profileBarJs.indexOf("}).catch(function() {", profileBarJs.indexOf("function loadHeader()"))
    const catchEnd = profileBarJs.indexOf("});", catchStart)
    new Function("generation", "healthGeneration", "renderHost", "renderStatus", "statusPillView",
      profileBarJs.slice(catchStart + "}).catch(function() {".length, catchEnd))(
        1, 1, controls.renderHost, controls.renderStatus, controls.statusPillView,
      )
  }
  return { button, dot, text, host, panel, region, document, render, failHealth }
}

describe("shared status rendering at phone width", () => {
  it("names enabled draining details when plain status text is hidden and hostname defaults off", () => {
    const f = fixture()
    expect(profileBarCss).toMatch(/@media \(max-width: 720px\)[\s\S]*\.mh-status \.mh-status-text \{ display: none; \}/)
    f.render({ status: "draining" })
    expect(f.text.textContent).toBe("Draining")
    expect(f.host.hidden).toBe(true)
    expect(f.button.disabled).toBe(false)
    expect(f.button.attributes.get("aria-label")).toBe("Draining; status details")
  })

  it("composes the current opt-in host and status, then removes stale host and disclosure labels", () => {
    const f = fixture()
    f.render({ status: "draining", hostname: "meridian-host.example.net" })
    expect(f.host.textContent).toBe("meridian-host")
    expect(f.button.attributes.get("aria-label")).toBe("Draining · meridian-host; status details")
    f.button.dispatchEvent(new Event("click"))
    expect(f.panel.hidden).toBe(false)
    f.render({ status: "healthy", hostname: "second.example.net" })
    expect(f.button.attributes.get("aria-label")).toBe("Operational · second")
    expect(f.button.disabled).toBe(true)
    expect(f.panel.hidden).toBe(true)
    f.render({ status: "draining" })
    expect(f.button.attributes.get("aria-label")).toBe("Draining; status details")
    expect(f.panel.hidden).toBe(true)
    f.failHealth()
    expect(f.button.attributes.get("aria-label")).toBe("Offline")
    expect(f.host.hidden).toBe(true)
    expect(f.panel.hidden).toBe(true)
  })

  it.each(["healthy", "degraded", "unhealthy"])("gives plain %s state a status name despite hidden phone text", (status) => {
    const f = fixture()
    f.render({ status })
    expect(f.button.attributes.get("aria-label")).toBe(status === "healthy" ? "Operational" : status === "degraded" ? "Degraded" : "Offline")
    expect(f.button.disabled).toBe(true)
    expect(f.panel.hidden).toBe(true)
  })

  it("does not let stale health overwrite the current status or opt-in hostname", () => {
    const f = fixture()
    f.render({ status: "draining", hostname: "current.example" }, 2, 2)
    f.render({ status: "healthy", hostname: "obsolete.example" }, 1, 2)
    expect(f.button.attributes.get("aria-label")).toBe("Draining · current; status details")
    expect(f.host.textContent).toBe("current")
    expect(f.text.textContent).toBe("Draining")
  })

  it("wires the actual serialized disclosure to page Escape without requiring button focus", () => {
    const f = fixture()
    f.render({ status: "draining", hostname: "current.example" })
    f.region.dispatchEvent(new Event("mouseenter"))
    expect(f.panel.hidden).toBe(false)
    const escape = new Event("keydown", { cancelable: true })
    Object.defineProperty(escape, "key", { value: "Escape" })
    f.document.dispatchEvent(escape)
    expect(f.panel.hidden).toBe(true)
    expect(f.button.attributes.get("aria-expanded")).toBe("false")
    expect(f.button.attributes.get("aria-label")).toBe("Draining · current; status details")
    expect(escape.defaultPrevented).toBe(false)
    f.render({ status: "draining", hostname: "current.example" })
    expect(f.panel.hidden).toBe(true)
  })

  it("makes the panel and its entire six-pixel trigger gap part of the shared hit region", () => {
    expect(profileBarHtml).toMatch(/<span class="mh-status-wrap" id="mhStatusWrap">[\s\S]*id="mhStatus"[\s\S]*id="mhStatusDetails"/)
    const panelRule = profileBarCss.match(/\.mh-status-details \{[^}]*\}/)?.[0] ?? ""
    expect(panelRule).not.toContain("pointer-events: none")
    expect(panelRule).toContain("top: calc(100% + 6px)")
    const bridge = profileBarCss.match(/\.mh-status-details::before \{[^}]*\}/)?.[0] ?? ""
    expect(bridge).toContain("top: -7px")
    expect(bridge).toContain("height: 7px")
    expect(bridge).toContain("left: -1px")
    expect(bridge).toContain("right: -1px")
  })
})
