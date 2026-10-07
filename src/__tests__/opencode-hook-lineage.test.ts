import { describe, expect, it } from "bun:test"
import { canonicalizeOpenCodeMessagesForLineage as canonicalize } from "../proxy/adapters/opencode"
import { computeLineageHash, computeMessageHashes, computeMessageBlockHashes, verifyLineage, type SessionState } from "../proxy/session/lineage"

const text = (value: string) => ({ type: "text", text: value })
const hook = (value: unknown) => text(`<user-prompt-submit-hook>${JSON.stringify(value)}</user-prompt-submit-hook>`)

describe("OpenCode transient hook lineage", () => {
  for (const payload of [
    { continue: true }, { continue: false, stopReason: "Stopped by the hook" },
    { suppressOutput: true }, { decision: "block", reason: "Hook policy" },
    { systemMessage: "Per-turn context" },
    { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Per-turn context" } },
  ]) {
    it(`canonicalizes the known hook output ${JSON.stringify(payload)}`, () => {
      const durable = text("Fixture value is ALPHA.")
      const original = [{ role: "user", content: [hook(payload), durable] }]
      const before = structuredClone(original)
      const stored = canonicalize(original)
      const incoming = canonicalize([{ role: "user", content: [durable] }, { role: "user", content: [text("Continue.")] }])
      const state: SessionState = { claudeSessionId: "source", lastAccess: 0, messageCount: stored.length,
        lineageHash: computeLineageHash(stored), messageHashes: computeMessageHashes(stored),
        messageBlockHashes: computeMessageBlockHashes(stored) }
      expect(verifyLineage(state, incoming)).toMatchObject({ type: "continuation", resumeFrom: 1 })
      expect(original).toEqual(before)
    })
  }

  for (const payload of [{}, { continue: "true" }, { continue: true, fixtureOverride: "BETA" },
    { decision: "unknown" }, { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "context" } }]) {
    it(`retains unrecognized or malformed hook output ${JSON.stringify(payload)}`, () => {
      const messages = [{ role: "user", content: [hook(payload), text("ALPHA")] }]
      expect(canonicalize(messages)).toEqual(messages)
    })
  }

  it("retains hook-only messages, assistant text and prose surrounding a hook", () => {
    const block = hook({ continue: true })
    const messages = [{ role: "user", content: [block] },
      { role: "assistant", content: [block, text("ALPHA")] },
      { role: "user", content: [text(`Explain ${block.text}`), text("ALPHA")] }]
    expect(canonicalize(messages)).toEqual(messages)
  })

  describe("oh-my-openagent prefill recovery text", () => {
    const recovery = text("[internal] Continue from the previous assistant state.")
    const toolUse = (id: string) => ({ type: "tool_use", id, name: "bash", input: { command: id } })
    const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `ran ${id}` })
    const stateFor = (stored: Array<{ role: string; content: unknown }>): SessionState => ({
      claudeSessionId: "source", lastAccess: 0, messageCount: stored.length,
      lineageHash: computeLineageHash(stored), messageHashes: computeMessageHashes(stored),
      messageBlockHashes: computeMessageBlockHashes(stored) })

    it("resumes the next tool round instead of replaying the conversation", () => {
      const head = [{ role: "user", content: [text("Run the checks.")] },
        { role: "assistant", content: [toolUse("a")] }]
      // The active round carries the recovery text after its tool result; the
      // next request moves it behind the new tail and the earlier slot loses it.
      const stored = canonicalize([...head, { role: "user", content: [toolResult("a"), recovery] }])
      const incoming = canonicalize([...head, { role: "user", content: [toolResult("a")] },
        { role: "assistant", content: [toolUse("b")] },
        { role: "user", content: [toolResult("b"), recovery] }])
      expect(verifyLineage(stateFor(stored), incoming)).toMatchObject({ type: "continuation", resumeFrom: 3 })
    })

    it("still treats the same history without canonicalization as modified", () => {
      const head = [{ role: "user", content: [text("Run the checks.")] },
        { role: "assistant", content: [toolUse("a")] }]
      const stored = [...head, { role: "user", content: [toolResult("a"), recovery] }]
      const incoming = [...head, { role: "user", content: [toolResult("a")] },
        { role: "assistant", content: [toolUse("b")] }, { role: "user", content: [toolResult("b"), recovery] }]
      expect(verifyLineage(stateFor(stored), incoming)).toMatchObject({ type: "diverged", reason: "modified-history" })
    })

    it("retains the text when it is a user's own message or differs at all", () => {
      const messages = [{ role: "user", content: [recovery] },
        { role: "user", content: [text("ALPHA"), recovery] },
        { role: "user", content: [toolResult("a"), text(`${recovery.text} `)] },
        { role: "assistant", content: [toolUse("a"), recovery] }]
      expect(canonicalize(messages)).toEqual(messages)
    })

    it("retains recovery wording outside the synthetic trailing tool-result shape", () => {
      const messages = [
        { role: "user", content: [recovery, toolResult("a")] },
        { role: "user", content: [toolResult("a"), recovery, text("A real follow-up.")] },
        { role: "user", content: [toolResult("a"), text("A real follow-up."), recovery] },
      ]
      expect(canonicalize(messages)).toEqual(messages)
    })

    it("recognizes a batch of tool results and a recognized transient hook", () => {
      const hook = text('<user-prompt-submit-hook>{"continue":true}</user-prompt-submit-hook>')
      const results = [toolResult("a"), toolResult("b")]
      expect(canonicalize([{ role: "user", content: [...results, recovery, hook] }]))
        .toEqual([{ role: "user", content: results }])
    })
  })

  it("preserves the order and identity of every surviving content block", () => {
    const before = text("ALPHA")
    const after = text("BETA")
    expect(canonicalize([{ role: "user", content: [before, hook({ continue: true }), after] }]))
      .toEqual([{ role: "user", content: [before, after] }])
  })
})
