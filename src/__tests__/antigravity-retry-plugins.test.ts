import { describe, expect, it } from 'bun:test'

interface Step { info: { id: string; role: string; parentID: string; agent: string; modelID: string; providerID: string; time: { completed?: number } } }
const incoming = { sessionID: 'session', agent: 'build', model: { id: 'gemini-fixture', providerID: 'meridian-agy' }, message: { id: 'user' } }
const step = (id = 'assistant'): Step => ({ info: { id, role: 'assistant', parentID: 'user', agent: 'build', modelID: 'gemini-fixture', providerID: 'meridian-agy', time: {} } })
type HeadersHook = (input: typeof incoming, output: { headers: Record<string, string> }) => Promise<void>
async function opencode(read: () => { data?: Step[]; error?: unknown }) {
  const path = new URL('../../examples/opencode-plugin/antigravity-retry.js', import.meta.url).href
  const plugin: { default: (context: { client: { session: { messages: (input: { path: { id: string } }) => Promise<ReturnType<typeof read>> } } }) => Promise<{ 'chat.headers': HeadersHook }> } = await import(path)
  return (await plugin.default({ client: { session: { messages: async input => { expect(input.path.id).toBe('session'); return read() } } } }))['chat.headers']
}

describe('Antigravity client retry identities', () => {
  it('keeps the OpenCode active assistant ID across retries and changes it for a new step', async () => {
    let current = step()
    const hook = await opencode(() => ({ data: [current] }))
    const first = { headers: { 'Idempotency-Key': 'stale' } as Record<string, string> }
    await hook(incoming, first)
    expect(first.headers['Idempotency-Key']).toBeUndefined()
    const second = { headers: {} }
    await hook(incoming, second)
    expect(second.headers).toEqual(first.headers)
    current = step('next-assistant')
    const third = { headers: {} }
    await hook(incoming, third)
    expect(third.headers).not.toEqual(first.headers)
  })
  it('does not guess an identity for completed, hidden or ambiguous steps', async () => {
    const completed = step(); completed.info.time.completed = 1
    for (const steps of [[], [completed], [step('one'), step('two')]]) {
      const hook = await opencode(() => ({ data: steps }))
      const output = { headers: { 'idempotency-key': 'stale' } as Record<string, string> }
      await hook(incoming, output)
      expect(output.headers).toEqual({})
    }
  })
  it('does not read unrelated provider sessions and fails explicitly when the public API fails', async () => {
    const hook = await opencode(() => ({ error: 'unavailable' }))
    const output = { headers: { 'idempotency-key': 'unrelated' } }
    await hook({ ...incoming, model: { ...incoming.model, providerID: 'another' } }, output)
    expect(output.headers['idempotency-key']).toBe('unrelated')
    await expect(hook(incoming, { headers: {} })).rejects.toThrow('Cannot read OpenCode')
  })
  it('retains Pi identity only for an exact failed turn and resets on new intent', async () => {
    type Hook = (event: { payload?: Record<string, unknown>; message?: { stopReason: string } }, context: { model?: { provider: string } }) => Record<string, unknown> | undefined
    const hooks = new Map<string, Hook>()
    const path = new URL('../../examples/pi-extension/antigravity-retry.js', import.meta.url).href
    const plugin: { default: (pi: { on: (name: string, handler: Hook) => void }) => void } = await import(path)
    plugin.default({ on: (name, handler) => { hooks.set(name, handler) } })
    const hook = hooks.get('before_provider_request')!
    const context = { model: { provider: 'meridian-agy' } }
    const payload = { model: 'gemini-fixture', messages: [] }
    const first = hook!({ payload }, { model: { provider: 'meridian-agy' } })!
    const second = hook!({ payload }, { model: { provider: 'meridian-agy' } })!
    expect(first.meridian_request_id).toBeString()
    expect(second.meridian_request_id).not.toBe(first.meridian_request_id)
    hooks.get('turn_end')!({ message: { stopReason: 'error' } }, context)
    expect(hook({ payload }, context)!.meridian_request_id).toBe(second.meridian_request_id)
    hooks.get('turn_end')!({ message: { stopReason: 'error' } }, context)
    expect(hook({ payload: { ...payload, model: 'changed' } }, context)!.meridian_request_id).not.toBe(second.meridian_request_id)
    for (const reset of ['before_agent_start', 'session_start', 'session_shutdown', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact']) {
      const current = hook({ payload }, context)!
      hooks.get('turn_end')!({ message: { stopReason: 'error' } }, context)
      hooks.get(reset)!({}, context)
      expect(hook({ payload }, context)!.meridian_request_id).not.toBe(current.meridian_request_id)
    }
    for (const stopReason of ['stop', 'toolUse', 'aborted']) {
      const current = hook({ payload }, context)!
      hooks.get('turn_end')!({ message: { stopReason } }, context)
      expect(hook({ payload }, context)!.meridian_request_id).not.toBe(current.meridian_request_id)
    }
    expect(payload).toEqual({ model: 'gemini-fixture', messages: [] })
    expect(hook!({ payload }, { model: { provider: 'another' } })).toBeUndefined()
  })
})
