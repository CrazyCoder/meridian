/** Observer sits outside the existing idle guard. These SDK-free controls
 * establish unchanged iteration/error/teardown ownership, not native proof. */
import { describe, expect, it } from "bun:test"
import { guardUpstreamIdle, UpstreamIdleError, type IdleGuardClock } from "../proxy/streamIdleGuard"
import { UpstreamReachability, withReachability } from "../proxy/upstreamReachability"

function controlledClock() {
  let now = 0
  let fire: (() => void) | undefined
  let armed: (() => void) | undefined
  const ready = new Promise<void>(resolve => { armed = resolve })
  const clock: IdleGuardClock = {
    now: () => now,
    setTimeout(callback) { fire = callback; armed?.(); return 1 },
    clearTimeout() { fire = undefined },
  }
  return { clock, ready, expire() { now = 30; fire?.() } }
}

function tracker() {
  return new UpstreamReachability(() => 0, () => ({ unreachableAfterMs: 0, holdMs: 300000, minFailures: 1 }))
}

describe("reachability observer teardown", () => {
  it("does not wait for a hostile native next/return when the idle guard settles", async () => {
    const clock = controlledClock()
    const health = tracker()
    let returns = 0
    const native: AsyncIterable<unknown> = { [Symbol.asyncIterator]() { return {
      next: () => new Promise<IteratorResult<unknown>>(() => {}),
      return: () => { returns++; return new Promise<IteratorResult<unknown>>(() => {}) },
    } } }
    const read = withReachability(guardUpstreamIdle(native, 30, undefined, clock.clock), health).next()
    await clock.ready
    clock.expire()
    let error: unknown
    try { await read } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(UpstreamIdleError)
    expect(returns).toBe(1)
    expect(health.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: null })
  })

  it("forwards the identical error and calls native return without joining its pending promise", async () => {
    const health = tracker()
    const original = new Error("Claude Code returned an error result: API Error: Connection refused (ECONNREFUSED)")
    let returns = 0
    const native: AsyncIterable<unknown> = { [Symbol.asyncIterator]() { return {
      next: () => Promise.reject(original),
      return: () => { returns++; return new Promise<IteratorResult<unknown>>(() => {}) },
    } } }
    let error: unknown
    try { await withReachability(guardUpstreamIdle(native, 30), health).next() }
    catch (caught) { error = caught }
    expect(error).toBe(original)
    expect(returns).toBe(1)
    expect(health.snapshot()).toMatchObject({ state: "unreachable", consecutiveFailures: 1, lastErrorKind: "refused" })
  })

  it("retains an observed terminal failure when the consumer exits before a result", async () => {
    const health = tracker()
    const terminal = { type: "assistant", error: "unknown", parent_tool_use_id: null,
      message: { id: "failed-one", type: "message", role: "assistant", model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Connection refused (ECONNREFUSED)" }] } }
    let returns = 0
    const native: AsyncIterable<unknown> = { [Symbol.asyncIterator]() { return {
      next: () => Promise.resolve({ done: false, value: terminal }),
      return: () => { returns++; return Promise.resolve({ done: true, value: undefined }) },
    } } }
    for await (const value of withReachability(guardUpstreamIdle(native, 30), health)) {
      expect(value).toBe(terminal)
      break
    }
    expect(returns).toBe(1)
    expect(health.snapshot()).toMatchObject({ state: "unreachable", consecutiveFailures: 1 })
  })
})
