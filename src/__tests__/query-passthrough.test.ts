/**
 * Tests for SDK parameter passthrough fields in buildQueryOptions.
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, type QueryContext } from "../proxy/query"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    isUndo: false,
    adapter: openCodeAdapter,
    ...overrides,
  }
}

describe("buildQueryOptions — SDK parameter passthrough", () => {
  it("passes effort to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ effort: "high" }))
    expect((result.options as any).effort).toBe("high")
  })

  it("passes thinking config to SDK options when provided", () => {
    const thinking = { type: "enabled" as const, budgetTokens: 4096 }
    const result = buildQueryOptions(makeContext({ thinking }))
    expect((result.options as any).thinking).toEqual(thinking)
  })

  it("passes taskBudget to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ taskBudget: { total: 10000 } }))
    expect((result.options as any).taskBudget).toEqual({ total: 10000 })
  })

  it("passes betas to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ betas: ["interleaved-thinking-2025-05-14"] }))
    expect((result.options as any).betas).toEqual(["interleaved-thinking-2025-05-14"])
  })

  it("omits effort, thinking, taskBudget, and betas from SDK options when not provided", () => {
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).effort).toBeUndefined()
    expect((result.options as any).thinking).toBeUndefined()
    expect((result.options as any).taskBudget).toBeUndefined()
    expect((result.options as any).betas).toBeUndefined()
  })
})
