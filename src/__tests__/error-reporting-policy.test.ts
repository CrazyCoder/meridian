import { describe, expect, it } from "bun:test"
import { nodeRejectionPolicy } from "../errorReporting/rejectionPolicy"
import { buildEnvelope, buildEvent } from "../errorReporting/event"

describe("error reporter policy and privacy", () => {
  it("respects Node policy precedence and quoted options without treating paths as flags", () => {
    expect(nodeRejectionPolicy([], undefined)).toBe("throw")
    expect(nodeRejectionPolicy([], '--unhandled-rejections="warn"')).toBe("warn")
    expect(nodeRejectionPolicy(["--unhandled-rejections", "none"], "--unhandled-rejections=warn")).toBe("none")
    expect(nodeRejectionPolicy([], '--require "some path --unhandled-rejections=none"')).toBe("throw")
    expect(nodeRejectionPolicy(["--unhandled-rejections=strict"], "--unhandled-rejections=none")).toBe("strict")
  })

  it("scrubs exception names throughout the cause chain before spooling and bounds their size", () => {
    const cause = new Error("inner"); cause.name = "Bearer synthetic-name-secret"
    const thrown = new Error("outer", { cause }); thrown.name = "x".repeat(10000) + " sk-ant-api03-syntheticsecret"
    const event = buildEvent({ eventId: "0".repeat(32), timestampMs: 1000, thrown,
      mechanism: "onuncaughtexception", handled: false, packageRoot: "/fixture",
      runtime: { name: "node", version: "22" } })
    const envelope = buildEnvelope(event)
    expect(envelope).not.toContain("synthetic-name-secret")
    expect(envelope).not.toContain("syntheticsecret")
    expect(event.exception.values[0]!.type).toBe("Bearer <redacted>")
    expect(event.exception.values[1]!.type.length).toBeLessThanOrEqual(2003)
  })
})
