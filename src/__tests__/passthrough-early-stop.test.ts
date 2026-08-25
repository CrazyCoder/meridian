/**
 * Unit tests for the passthrough early-stop tracker — pure functions, no mocks.
 *
 * In passthrough, the model's tool calls are denied ("forwarded to client")
 * and the SDK then invokes the model AGAIN to digest the deny — a throwaway
 * turn that is fully billed (on always-thinking models it's a whole thinking
 * pass per tool step). The tracker watches the SDK stream: once every
 * client-forwarded tool_use has its deny tool_result persisted (observed as a
 * `user` message), the proxy can abort the query BEFORE the digest turn fires.
 * Verified SDK behavior: denied tool_results ARE emitted as user messages
 * between assistant turns.
 */
import { describe, it, expect } from "bun:test"
import {
  clientAbortDisposition,
  createEarlyStopTracker,
  allForwardedCallsResolved,
  isClientForwardedToolUse,
  isCompleteToolResultContinuation,
  noteAssistantContent,
  noteAssistantMessage,
  noteOrderingUnsafe,
  noteUserContent,
  settledToolCallAssistantUuid,
  shouldEarlyStop,
} from "../proxy/passthroughEarlyStop"

import { PASSTHROUGH_MCP_PREFIX } from "../proxy/passthroughTools"

const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name })
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, is_error: true })
const sdkAssistant = (uuid: unknown, content: unknown) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content },
})

describe("prefix cross-check", () => {
  it("tracker's duplicated prefix matches the passthrough MCP prefix", () => {
    // The tracker duplicates the prefix to stay leaf-pure; this guards drift.
    expect(isClientForwardedToolUse(toolUse("t1", `${PASSTHROUGH_MCP_PREFIX}read`))).toBe(true)
  })
})

describe("isClientForwardedToolUse", () => {
  it("matches passthrough-prefixed MCP tools", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "mcp__oc__read"))).toBe(true)
  })

  it("matches bare tool names (SDK sometimes strips the prefix in events)", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "read"))).toBe(true)
    expect(isClientForwardedToolUse(toolUse("t2", "Bash"))).toBe(true)
  })

  it("excludes ToolSearch (internal, SDK-executed for deferred loading)", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "ToolSearch"))).toBe(false)
  })

  it("excludes internal MCP tools from other servers", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "mcp__opencode__read"))).toBe(false)
  })

  it("excludes non-tool_use blocks", () => {
    expect(isClientForwardedToolUse({ type: "text", text: "hi" })).toBe(false)
    expect(isClientForwardedToolUse({ type: "server_tool_use", id: "s1", name: "advisor" })).toBe(false)
  })

  it("excludes tool_use blocks with no id (can't be tracked)", () => {
    expect(isClientForwardedToolUse({ type: "tool_use", name: "read" })).toBe(false)
  })
})

describe("clientAbortDisposition", () => {
  const base = {
    isIndependentSession: false,
    profileSessionId: "s1",
    currentSessionId: "claude-1",
    sawDuplicateToolUse: false,
    toolCallAssistantUuid: "a1",
    passthrough: true,
  }

  it("evicts even when an assistant UUID was observed before the abort", () => {
    expect(clientAbortDisposition(base)).toEqual({ action: "evict" })
  })

  it("evicts when no assistant checkpoint exists — nothing is safe to resume from", () => {
    // The interrupted tail would make the SDK synthesize a continuation the
    // model answers with an empty turn, and every empty turn becomes the next
    // tail. A fresh replay is the cost of not wedging the conversation.
    expect(clientAbortDisposition({ ...base, toolCallAssistantUuid: undefined })).toEqual({ action: "evict" })
  })

  // A deny boundary is a passthrough concept. In internal mode the SDK runs the
  // tools itself, so a user message carrying tool_results is an ordinary turn —
  // persisting its uuid as a spent deny would make the next continuation fork
  // from a point that was never a boundary.
  it("never records a passthrough checkpoint for an internal-mode abort", () => {
    expect(clientAbortDisposition({ ...base, passthrough: false })).toEqual({ action: "evict" })
  })

  it("evicts when the SDK session id never arrived", () => {
    expect(clientAbortDisposition({ ...base, currentSessionId: undefined })).toEqual({ action: "evict" })
  })

  it("evicts on a duplicate-aborted history (#552) even with a boundary", () => {
    expect(clientAbortDisposition({ ...base, sawDuplicateToolUse: true })).toEqual({ action: "evict" })
  })

  it("does nothing for fork/subagent requests — they never write the cache", () => {
    expect(clientAbortDisposition({ ...base, isIndependentSession: true })).toEqual({ action: "none" })
  })

  it("does nothing without a session key", () => {
    expect(clientAbortDisposition({ ...base, profileSessionId: undefined })).toEqual({ action: "none" })
  })
})

describe("assistant resume checkpoint", () => {
  const assistantMsg = (uuid: unknown, content: unknown) => ({
    type: "assistant",
    uuid,
    message: { role: "assistant", content },
  })

  it("stores the UUID of an assistant message carrying a forwarded tool_use", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    expect(tracker.toolCallAssistantUuid).toBe("a1")
  })

  it("advances to the final assistant fragment for parallel tool calls", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, assistantMsg("a2", [toolUse("t2", "grep")]))
    noteUserContent(tracker, [toolResult("t1"), toolResult("t2")])
    expect(settledToolCallAssistantUuid(tracker)).toBe("a2")
  })

  it("never accepts a user/tool-result UUID as a resume checkpoint", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [toolResult("t1")] },
    })
    expect(tracker.toolCallAssistantUuid).toBeUndefined()
  })

  it("does not expose a boundary until every forwarded call settled", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [
      toolUse("t1", "read"),
      toolUse("t2", "grep"),
    ]))
    noteUserContent(tracker, [toolResult("t1")])
    expect(allForwardedCallsResolved(tracker)).toBe(false)
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    noteUserContent(tracker, [toolResult("t2")])
    expect(allForwardedCallsResolved(tracker)).toBe(true)
    expect(settledToolCallAssistantUuid(tracker)).toBe("a1")
  })

  it("fails closed when the tool-bearing assistant message has no usable UUID", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg(undefined, [toolUse("t1", "read")]))
    noteUserContent(tracker, [toolResult("t1")])
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    expect(shouldEarlyStop(tracker)).toBe(false)
  })

  it("invalidates an older checkpoint when a later tool-bearing message has no UUID", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, assistantMsg(undefined, [toolUse("t2", "grep")]))
    noteUserContent(tracker, [toolResult("t1"), toolResult("t2")])
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    expect(shouldEarlyStop(tracker)).toBe(false)
  })
})

/**
 * resumeSessionAt slices the loaded transcript to (0, checkpointIndex + 1), so
 * a checkpoint is only usable when every deny lands after it. An unheld deny
 * interleaves with the per-block assistant rows (A U A U), and measured against
 * the real SDK the first N-1 denies of an N-call turn survive that slice and
 * are replayed to the model as "NOT executed" for calls it then also receives
 * real output for.
 */
describe("ordering invariant: no deny may precede the checkpoint", () => {
  const assistantMsg = (uuid: unknown, content: unknown) => ({
    type: "assistant",
    uuid,
    message: { role: "assistant", content },
  })

  it("accepts the held ordering — every assistant row before any deny (A A U U)", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, assistantMsg("a2", [toolUse("t2", "read")]))
    noteUserContent(tracker, [toolResult("t1")])
    noteUserContent(tracker, [toolResult("t2")])
    expect(tracker.orderingUnsafeReason).toBeUndefined()
    expect(settledToolCallAssistantUuid(tracker)).toBe("a2")
    expect(shouldEarlyStop(tracker)).toBe(true)
  })

  it("does NOT infer a violation from iterator order (A U A U)", () => {
    // Iterator order is not transcript order. The SDK surfaces a deny before
    // the late per-block assistant metadata of a turn that already finished
    // generating, and the CLI still writes that transcript as A A U U — the
    // real-proxy probe measures zero survivors for exactly this sequence.
    // Refusing here would throw away good checkpoints on the healthy path.
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteUserContent(tracker, [toolResult("t1")])
    noteAssistantMessage(tracker, assistantMsg("a2", [toolUse("t2", "read")]))
    noteUserContent(tracker, [toolResult("t2")])
    expect(tracker.orderingUnsafeReason).toBeUndefined()
    expect(settledToolCallAssistantUuid(tracker)).toBe("a2")
  })

  it("keeps parallel calls in ONE assistant message safe", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read"), toolUse("t2", "grep")]))
    noteUserContent(tracker, [toolResult("t1")])
    noteUserContent(tracker, [toolResult("t2")])
    expect(tracker.orderingUnsafeReason).toBeUndefined()
    expect(settledToolCallAssistantUuid(tracker)).toBe("a1")
  })

  it("refuses the checkpoint when the deny hold expired", () => {
    // The causal signal: the hold is what keeps denies after the checkpoint, so
    // an expiry means the log order can no longer be trusted.
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteOrderingUnsafe(tracker, "deny_hold_timeout")
    noteUserContent(tracker, [toolResult("t1")])
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    expect(shouldEarlyStop(tracker)).toBe(false)
  })

  it("stays refused once marked, whatever the reason", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteUserContent(tracker, [toolResult("t1")])
    noteOrderingUnsafe(tracker, "deny_hold_timeout")
    expect(tracker.orderingUnsafeReason).toBe("deny_hold_timeout")
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    // First reason wins — the earliest cause is the one worth reporting.
    noteOrderingUnsafe(tracker, "something_else")
    expect(tracker.orderingUnsafeReason).toBe("deny_hold_timeout")
  })
})

describe("early-stop tracking", () => {
  it("does not stop before any tool calls are seen", () => {
    const t = createEarlyStopTracker()
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("does not stop on a text-only assistant turn", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [{ type: "text", text: "final answer" }])
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("stops after the single tool call's deny is observed", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-single", [toolUse("t1", "mcp__oc__read")]))
    expect(shouldEarlyStop(t)).toBe(false) // deny not yet persisted
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("waits for ALL parallel tool calls' denies before stopping", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-parallel", [
      { type: "text", text: "reading both" },
      toolUse("t1", "mcp__oc__read"),
      toolUse("t2", "mcp__oc__grep"),
    ]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(false) // t2's deny still pending — do NOT drop it
    noteUserContent(t, [toolResult("t2")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("fires only once (idempotent after stop)", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-idempotent", [toolUse("t1", "read")]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("ignores ToolSearch turns — waits for the real tool call (deferred flow)", () => {
    const t = createEarlyStopTracker()
    // Turn 1: ToolSearch (internal, executes for real)
    noteAssistantContent(t, [toolUse("ts1", "ToolSearch")])
    noteUserContent(t, [toolResult("ts1")]) // real ToolSearch result
    expect(shouldEarlyStop(t)).toBe(false)
    // Turn 2: the actual client tool call
    noteAssistantMessage(t, sdkAssistant("a-single", [toolUse("t1", "mcp__oc__read")]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("ignores unrelated tool_results (defensive)", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [toolUse("t1", "read")])
    noteUserContent(t, [toolResult("unknown-id")])
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("tolerates non-array and malformed content", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, "just a string" as unknown)
    noteAssistantContent(t, null as unknown)
    noteUserContent(t, undefined as unknown)
    noteUserContent(t, [{ type: "text", text: "hi" }])
    expect(shouldEarlyStop(t)).toBe(false)
  })
})


describe("isCompleteToolResultContinuation", () => {
  const result = (id: string, content: unknown = "ok") => ({ type: "tool_result", tool_use_id: id, content })

  it("accepts one complete parallel result batch", () => {
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [result("t1"), result("t2")] },
    ], ["t1", "t2"])).toBe(true)
  })

  it("rejects a partial batch and an unknown result id", () => {
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
    ], ["t1", "t2"])).toBe(false)
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [result("unknown")] },
    ], ["t1"])).toBe(false)
  })

  it("rejects multiple user messages so multimodal results stay on the final SDK input", () => {
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ], ["t1"])).toBe(false)
  })

  it("requires tool results before ordinary user content", () => {
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [{ type: "text", text: "first" }, result("t1")] },
    ], ["t1"])).toBe(false)
    expect(isCompleteToolResultContinuation([
      { role: "user", content: [result("t1"), { type: "text", text: "then continue" }] },
    ], ["t1"])).toBe(true)
  })
})
