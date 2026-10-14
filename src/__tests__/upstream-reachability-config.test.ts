import { describe, expect, it } from "bun:test"
import { DEFAULT_REACHABILITY_THRESHOLDS, UpstreamReachability } from "../proxy/upstreamReachability"
import { resolveReachabilityThresholds } from "../proxy/upstreamReachabilityConfig"

describe("resolveReachabilityThresholds", () => {
  const none = () => undefined
  const noSettings = () => ({})

  it("falls back to the defaults", () => {
    expect(resolveReachabilityThresholds(none, noSettings)).toEqual({ unreachableAfterMs: 120_000, holdMs: 300_000, minFailures: 3 })
  })

  it("reads settings.json, and lets the environment win", () => {
    const settings = () => ({ upstreamUnreachableAfterMs: 60_000, upstreamUnreachableHoldMs: 0, upstreamUnreachableMinFailures: 5 })
    expect(resolveReachabilityThresholds(none, settings)).toEqual({ unreachableAfterMs: 60_000, holdMs: 0, minFailures: 5 })
    const environment = (suffix: string) => ({
      UPSTREAM_UNREACHABLE_AFTER_MS: "10000",
      UPSTREAM_UNREACHABLE_HOLD_MS: "20000",
      UPSTREAM_UNREACHABLE_MIN_FAILURES: "2",
    } as Record<string, string>)[suffix]
    expect(resolveReachabilityThresholds(environment, settings)).toEqual({ unreachableAfterMs: 10_000, holdMs: 20_000, minFailures: 2 })
  })

  it("ignores a value that is not a non-negative integer, and never needs fewer than one failure", () => {
    const environment = (suffix: string) => ({ UPSTREAM_UNREACHABLE_AFTER_MS: "two minutes", UPSTREAM_UNREACHABLE_HOLD_MS: "-5" } as Record<string, string>)[suffix]
    const settings = () => ({ upstreamUnreachableHoldMs: 1.5, upstreamUnreachableMinFailures: 0 })
    expect(resolveReachabilityThresholds(environment, settings)).toEqual({ unreachableAfterMs: 120_000, holdMs: 300_000, minFailures: 1 })
  })

  it("rereads injected acquisition on observations and snapshots without recreating the tracker", () => {
    let settings: unknown = { upstreamUnreachableAfterMs: 0, upstreamUnreachableHoldMs: 600_000, upstreamUnreachableMinFailures: 1 }
    let reads = 0
    const reach = new UpstreamReachability(() => 1_000_000, () => resolveReachabilityThresholds(none, () => { reads++; return settings }))
    reach.recordFailure("dns")
    expect(reads).toBe(1)
    expect(reach.snapshot().state).toBe("unreachable")
    expect(reads).toBe(2)
    settings = { upstreamUnreachableHoldMs: 0 }
    expect(reach.snapshot().state).toBe("probing")
    expect(reads).toBe(3)
  })

  it("preserves dynamic MERIDIAN precedence and legacy CLAUDE_PROXY aliases for all three fields", () => {
    const names = ["AFTER_MS", "HOLD_MS", "MIN_FAILURES"].flatMap(suffix => ["MERIDIAN_UPSTREAM_UNREACHABLE_" + suffix, "CLAUDE_PROXY_UPSTREAM_UNREACHABLE_" + suffix])
    const saved = new Map(names.map(name => [name, process.env[name]]))
    try {
      for (const name of names) delete process.env[name]
      process.env.CLAUDE_PROXY_UPSTREAM_UNREACHABLE_AFTER_MS = "60"
      process.env.CLAUDE_PROXY_UPSTREAM_UNREACHABLE_HOLD_MS = "120"
      process.env.CLAUDE_PROXY_UPSTREAM_UNREACHABLE_MIN_FAILURES = "4"
      expect(resolveReachabilityThresholds(undefined, noSettings)).toEqual({ unreachableAfterMs: 60, holdMs: 120, minFailures: 4 })
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS = "30"
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS = "90"
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_MIN_FAILURES = "2"
      expect(resolveReachabilityThresholds(undefined, noSettings)).toEqual({ unreachableAfterMs: 30, holdMs: 90, minFailures: 2 })
      // The newer alias still wins when malformed; safe settings/defaults,
      // rather than the legacy alias, are the approved fallback in that case.
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS = "invalid"
      expect(resolveReachabilityThresholds(undefined, () => ({ upstreamUnreachableAfterMs: 15 }))).toEqual({ unreachableAfterMs: 15, holdMs: 90, minFailures: 2 })
      for (const name of names.filter(name => name.startsWith("MERIDIAN_"))) delete process.env[name]
      expect(resolveReachabilityThresholds(undefined, noSettings)).toEqual({ unreachableAfterMs: 60, holdMs: 120, minFailures: 4 })
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe("strict persisted configuration controls", () => {
  it.each<[unknown]>([[null], [[]], ["settings"], [23], [false]])("ignores non-record settings: %j", (value) => {
    const settings = () => JSON.parse(JSON.stringify(value))
    expect(resolveReachabilityThresholds(() => undefined, settings)).toEqual(DEFAULT_REACHABILITY_THRESHOLDS)
  })

  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity])("ignores an unrepresentable duration: %s", (value) => {
    const settings = () => ({ upstreamUnreachableAfterMs: value, upstreamUnreachableHoldMs: value })
    expect(resolveReachabilityThresholds(() => undefined, settings)).toEqual(DEFAULT_REACHABILITY_THRESHOLDS)
  })

  it("does not coerce numeric strings from persisted settings", () => {
    const settings = () => ({ upstreamUnreachableAfterMs: "0", upstreamUnreachableHoldMs: "0", upstreamUnreachableMinFailures: "1" })
    expect(resolveReachabilityThresholds(() => undefined, settings)).toEqual(DEFAULT_REACHABILITY_THRESHOLDS)
  })

})
