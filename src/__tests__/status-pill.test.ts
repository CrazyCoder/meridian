/**
 * The header's health pill, as rendered from raw `/health` JSON.
 */

import { describe, expect, it } from "bun:test"
import { statusPillView } from "../telemetry/statusPill"

const UNREACHABLE = {
  state: "unreachable",
  since: "2026-10-01T21:02:00.000Z",
  failingSince: "2026-10-01T21:00:00.000Z",
  consecutiveFailures: 7,
  lastReachedAt: "2026-10-01T20:59:58.000Z",
  lastFailureAt: "2026-10-01T21:03:00.000Z",
  lastErrorKind: "dns",
  holdUntil: "2026-10-01T21:08:00.000Z",
  override: null,
}

const local = (iso: string) => new Date(iso).toLocaleString()

describe("statusPillView", () => {
  it("keeps the plain status when the upstream is reachable or not reported", () => {
    expect(statusPillView({ status: "healthy" })).toEqual({ tone: "healthy", text: "Operational", title: "", alert: null })
    expect(statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE, state: "ok" } } }).text).toBe("Operational")
    expect(statusPillView({ status: "degraded" })).toMatchObject({ tone: "degraded", text: "Degraded" })
    expect(statusPillView({ status: "unhealthy" })).toMatchObject({ tone: "unhealthy", text: "Offline" })
    expect(statusPillView(null)).toMatchObject({ tone: "unhealthy", text: "Offline", alert: null })
  })

  it("shows an outage, with since and the last error on hover", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: UNREACHABLE } })
    expect(view).toMatchObject({ tone: "unhealthy", text: "Claude connection failed", alert: "outage" })
    expect(view.title).toContain("Failing since: " + local(UNREACHABLE.failingSince))
    expect(view.title).toContain("Last error: dns (7 connection failures)")
    expect(view.title).toContain("Last answered: " + local(UNREACHABLE.lastReachedAt))
    expect(view.title).toContain("let back in at " + local(UNREACHABLE.holdUntil))
  })

  // The auth check behind `status` fails along with the resolver, and
  // "Offline" would send someone to `claude login` for a network problem.
  it("shows transport failure only when the instance is operational or degraded", () => {
    expect(statusPillView({ status: "degraded", upstream: { claude: UNREACHABLE } }).text).toBe("Claude connection failed")
    expect(statusPillView({ status: "unhealthy", upstream: { claude: UNREACHABLE } }).text).toBe("Offline")
  })

  it("says when the outage is a forced test state", () => {
    const view = statusPillView({
      status: "healthy",
      upstream: { claude: { ...UNREACHABLE, holdUntil: null, override: { state: "unreachable", until: "2026-10-01T21:10:00.000Z" } } },
    })
    expect(view.text).toBe("Claude connection failed")
    expect(view.title).toBe("This instance's configured Claude egress is forced unreachable by a test override until " + local("2026-10-01T21:10:00.000Z") + ".")
  })

  it("shows the way back as a yellow recheck", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE, state: "probing", holdUntil: null } } })
    expect(view).toMatchObject({ tone: "degraded", text: "Rechecking Claude connection", alert: "recovering" })
    expect(view.title).toContain("(last error: dns)")
    expect(view.title).toContain("Last failure: " + local(UNREACHABLE.lastFailureAt))
  })

  it("survives malformed fields", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: { state: "unreachable", since: "not a date", lastErrorKind: 5 } } })
    expect(view.text).toBe("Claude connection failed")
    expect(view.title).toContain("Failing since: unknown")
    expect(view.title).toContain("Last error: connection")
    expect(view.title).toContain("Last answered: never since start")
  })

  // Serialized into the header script: anything it closes over is undefined
  // in the browser.
  it("is self-contained", () => {
    const rebuilt = new Function(`return (${statusPillView.toString()})`)() as typeof statusPillView
    expect(rebuilt({ status: "healthy", upstream: { claude: UNREACHABLE } }).text).toBe("Claude connection failed")
  })
})


describe("status pill provider and shutdown composition", () => {
  it("keeps shutdown/offline authority ahead of forced and natural network alerts", () => {
    for (const state of ["unreachable", "probing"]) {
      const upstream = { claude: { ...UNREACHABLE, state } }
      expect(statusPillView({ status: "draining", upstream })).toMatchObject({ text: "Draining", alert: null })
      expect(statusPillView({ status: "unhealthy", upstream })).toMatchObject({ text: "Offline", alert: null })
      expect(statusPillView({ status: "unknown", upstream })).toMatchObject({ text: "Offline", alert: null })
    }
  })
  it("does not claim standalone Antigravity is affected by Claude observations", () => {
    expect(statusPillView({ status: "healthy", backend: "antigravity", upstream: { claude: UNREACHABLE } }))
      .toMatchObject({ text: "Operational", alert: null })
    const combined = statusPillView({ status: "healthy", backend: "combined", upstream: { claude: UNREACHABLE } })
    expect(combined.text).toBe("Claude connection failed")
    expect(combined.title).toContain("Antigravity is independent")
  })
  it("does not render untrusted error text or unsafe failure counts", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE,
      lastErrorKind: "private raw error", consecutiveFailures: Number.MAX_VALUE } } })
    expect(view.title).not.toContain("private raw error")
    expect(view.title).not.toContain(String(Number.MAX_VALUE))
    const malformed = statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE,
      lastErrorKind: { toString: null, valueOf: null } } } })
    expect(malformed.title).toContain("Last error: connection")
    expect(statusPillView([ { status: "healthy" } ]).text).toBe("Offline")
  })
})
