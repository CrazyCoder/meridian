import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgCompletedAnswers, replayAgAnswer, type AgCompletedAnswer } from '../proxy/backends/antigravityReplay'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'
import { AgState } from '../proxy/backends/antigravityState'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

const request = (id = 'completed') => parseAgRequest({ model: 'fixture-model', max_tokens: 100, tools: [], messages: [
  { role: 'user', content: 'lookup' },
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'lookup', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'PRIVATE_RECEIPT' }] },
] })
const answer: AgCompletedAnswer = { id: 'msg_saved', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'PRIVATE_RECEIPT' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 120, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function directory() { const root = mkdtempSync(join(tmpdir(), 'agy-answer-test-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root }

describe('Antigravity completed answer storage', () => {
  it('persists unfinished identities across restart and refuses blind replay without storing prompts', () => {
    const path = join(directory(), 'state.sqlite')
    let state = new AgState(path)
    new AgCompletedAnswers(state).claim(request(), 'owner', 'unfinished')
    expect(state.list('unfinished-requests').join('')).not.toContain('PRIVATE_RECEIPT')
    state.close()
    state = new AgState(path); cleanup.push(() => state.close())
    const store = new AgCompletedAnswers(state)
    expect(() => store.claim(request(), 'owner', 'unfinished')).toThrow('outcome is uncertain')
    expect(() => store.claim({ ...request(), model: 'changed' }, 'owner', 'unfinished')).toThrow('different request')
    const release = store.claim(request(), 'other', 'unfinished')
    release()
    expect(state.records('unfinished-requests')).toHaveLength(1)
  })
  it('keeps saved responses recoverable even if the owner dies before releasing its claim', () => {
    const path = join(directory(), 'state.sqlite')
    let state = new AgState(path)
    const original = new AgCompletedAnswers(state)
    original.claim(request(), 'owner', 'saved')
    original.put(request(), 'owner', answer, 'saved')
    state.close()
    state = new AgState(path); cleanup.push(() => state.close())
    expect(new AgCompletedAnswers(state).get(request(), 'owner', 'saved')).toEqual(answer)
  })
  it('releases cleanly joined requests and never evicts unresolved guards for admission', () => {
    const state = new AgState(join(directory(), 'state.sqlite')); cleanup.push(() => state.close())
    const store = new AgCompletedAnswers(state)
    const release = store.claim(request(), 'owner', 'clean')
    release(); release()
    store.claim(request(), 'owner', 'clean')()
    expect(state.records('unfinished-requests')).toHaveLength(0)
    for (let i = 0; i < 128; i++) new AgCompletedAnswers(state).claim(request(), 'owner', `pending-${i}`)
    expect(() => new AgCompletedAnswers(state).claim(request(), 'owner', 'overflow')).toThrow('journal is full')
    expect(() => new AgCompletedAnswers(state).claim(request(), 'owner', 'pending-0')).toThrow('outcome is uncertain')
    for (const row of state.records('unfinished-requests')) state.put('unfinished-requests', row.id, row.scope, 'expired', Date.now() - 1, 128, 65536)
    new AgCompletedAnswers(state).claim(request(), 'owner', 'after-expiry')()
  })

  it('requires exact contract/history/tool choice and credential scope, but allows a transport change', () => {
    const store = new AgCompletedAnswers(), body = request()
    store.put(body, 'owner', answer)
    expect(store.get({ ...body, stream: true }, 'owner')).toEqual(answer)
    expect(store.get(body, 'other')).toBeUndefined()
    for (const changed of [{ max_tokens: 200 }, { model: 'fixture-model-high' }, { system: 'changed' }, { tool_choice: { type: 'none' as const } }, { meridian_session_key: 'another' }, { messages: [...body.messages.slice(0, -1), { role: 'user' as const, content: 'new prompt' }] }]) expect(store.get({ ...body, ...changed }, 'owner')).toBeUndefined()
    const saved = store.get(body, 'owner')!
    if (saved.content[0]?.type === 'text') saved.content[0].text = 'mutated'
    expect(store.get(body, 'owner')).toEqual(answer)
    const ordinary = parseAgRequest({ model: 'fixture-model', max_tokens: 100, messages: [{ role: 'user', content: 'same prompt' }] })
    store.put(ordinary, 'owner', answer)
    expect(store.get(ordinary, 'owner')).toBeUndefined()
  })
  it('bounds entry count and skips oversized snapshots without evicting valid answers', () => {
    const store = new AgCompletedAnswers()
    for (let i = 0; i < 129; i++) store.put(request(String(i)), 'owner', answer)
    expect(store.get(request('0'), 'owner')).toBeUndefined()
    expect(store.get(request('1'), 'owner')).toEqual(answer)
    store.put(request('large'), 'owner', { ...answer, content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] })
    expect(store.get(request('large'), 'owner')).toBeUndefined()
    expect(store.get(request('1'), 'owner')).toEqual(answer)
  })
  it('retains bounded durable snapshots across restart without exposing them as Responses', () => {
    const path = join(directory(), 'state.sqlite')
    let state = new AgState(path)
    new AgCompletedAnswers(state).put(request(), 'owner', answer)
    expect(state.records('responses')).toHaveLength(0)
    state.close()
    state = new AgState(path); cleanup.push(() => state.close())
    const store = new AgCompletedAnswers(state)
    expect(store.get(request(), 'owner')).toEqual(answer)
    expect(store.get(request(), 'stranger')).toBeUndefined()
  })
  it('enforces the combined byte budget and expires durable entries', () => {
    const state = new AgState(join(directory(), 'state.sqlite')); cleanup.push(() => state.close())
    const store = new AgCompletedAnswers(state)
    const large = { ...answer, content: [{ type: 'text' as const, text: 'x'.repeat(900000) }] }
    for (let i = 0; i < 20; i++) store.put(request(String(i)), 'owner', large)
    expect(state.records('completed-answers').reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(store.get(request('0'), 'owner')).toBeUndefined()
    expect(store.get(request('19'), 'owner')).toEqual(large)
    for (const row of state.records('completed-answers')) state.put('completed-answers', row.id, row.scope, '{}', Date.now() - 1, 128, 16 * 1024 * 1024)
    expect(new AgCompletedAnswers(state).get(request('19'), 'owner')).toBeUndefined()
  })
  it('binds explicit identities to their request and shares the existing count budget', () => {
    const store = new AgCompletedAnswers(), body = request()
    store.put(body, 'owner', answer)
    for (let i = 0; i < 128; i++) store.put(body, 'owner', answer, `explicit-${i}`)
    expect(store.get(body, 'owner')).toBeUndefined()
    expect(store.get(body, 'owner', 'explicit-127')).toEqual(answer)
    expect(() => store.get({ ...body, max_tokens: 200 }, 'owner', 'explicit-127')).toThrow('different request')
    expect(store.get(body, 'other', 'explicit-127')).toBeUndefined()
    expect(() => store.put(body, 'owner', { ...answer, content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }, 'oversized')).toThrow('1 MiB')
  })
  it('reconstructs tool JSON, including Unicode arguments, as bounded SSE deltas', async () => {
    const call = { type: 'tool_use' as const, id: 'original-call', name: 'lookup', input: { value: 'x'.repeat(4090) + '🧪你好' } }
    const response = replayAgAnswer({ ...answer, content: [call], stop_reason: 'tool_use' }, true, {})
    const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.split('\ndata: ')[1]!))
    expect(events.find(event => event.type === 'content_block_start').content_block).toEqual({ ...call, input: {} })
    expect(JSON.parse(events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''))).toEqual(call.input)
  })
  it('bounds concurrent waiters and releases cancelled waiters immediately', async () => {
    const store = new AgCompletedAnswers(), body = request()
    const release = store.claim(body, 'owner', 'active')
    const aborts = Array.from({ length: 128 }, () => new AbortController())
    const waiters = aborts.map(abort => store.wait(body, 'owner', 'active', abort.signal).catch(error => error))
    await expect(store.wait(body, 'owner', 'active', new AbortController().signal)).rejects.toThrow('Too many retries')
    aborts[0]!.abort()
    const replacement = store.wait(body, 'owner', 'active', new AbortController().signal)
    release()
    await replacement
    const results = await Promise.all(waiters)
    expect(results[0]).toBeInstanceOf(Error)
    expect(results.slice(1).every(result => result === undefined)).toBe(true)
  })
  it('reconstructs complete SSE including exact unicode, message identity, stops and usage', async () => {
    const value = { ...answer, content: [{ type: 'text' as const, text: 'x'.repeat(4095) + '🧪 café' }], stop_reason: 'stop_sequence', stop_sequence: 'END' }
    const response = replayAgAnswer(value, true, { 'x-meridian-effective-model': 'fixture-model' })
    expect(response.headers.get('x-meridian-response-replayed')).toBe('true')
    const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.split('\ndata: ')[1]!))
    expect(events[0].message.id).toBe(value.id)
    expect(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')).toBe(value.content[0]!.text)
    expect(events.at(-2)).toEqual({ type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' }, usage: value.usage })
    expect(events.at(-1).type).toBe('message_stop')
    expect(await replayAgAnswer(value, false, {}).json()).toEqual(value)
  })
})

describe.skipIf(process.platform === 'win32')('Antigravity completed answer HTTP recovery', () => {
  it('joins identified-request telemetry cleanup before closing durable state', async () => {
    const statePath = join(directory(), 'state.sqlite')
    let entered!: () => void, release!: () => void, closed = false
    const observing = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), statePath, plugins: [{ name: 'slow', onTelemetry: async () => { entered(); await hold } }] })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
    cleanup.push(server.closeBackend)
    const pending = server.app.fetch(new Request('http://local/v1/messages', { method: 'POST', headers: { 'idempotency-key': 'shutdown' }, body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] }) }))
    await observing
    const closing = server.closeBackend().then(() => { closed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(closed).toBe(false)
      expect(runtime.state?.records('unfinished-requests')).toHaveLength(1)
    } finally { release(); await closing }
    expect((await pending).status).toBe(200)
    const reopened = new AgState(statePath)
    try { expect(reopened.records('unfinished-requests')).toHaveLength(0) } finally { reopened.close() }
  })

  it('keeps state open until already-exited workspace cleanup has joined', async () => {
    const runtime = new AntigravityRuntime({ statePath: join(directory(), 'state.sqlite') })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
    let release!: () => void, closed = false
    const settling = new Promise<void>(resolve => { release = resolve })
    runtime.settling.add(settling)
    const closing = server.closeBackend().then(() => { closed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(closed).toBe(false)
      expect(runtime.state?.records('completed-answers')).toEqual([])
    } finally { runtime.settling.delete(settling); release(); await closing }
    expect(closed).toBe(true)
  })
  it('does not add hidden answer storage to OpenAI store:false requests', async () => {
    const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), statePath: join(directory(), 'state.sqlite'), reuseConversations: false, allowToolBridge: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
    cleanup.push(server.closeBackend)
    const response = await server.app.fetch(new Request('http://local/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'fixture-model', store: false, input: [
      { role: 'user', content: 'lookup' },
      { type: 'function_call', call_id: 'previous', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'previous', output: 'UNSTORED' },
    ] }) }))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('UNSTORED')
    expect(runtime.state?.records('completed-answers')).toHaveLength(0)
    expect(runtime.state?.records('responses')).toHaveLength(0)
  })
  it('restores identified tool delivery after restart without starting another CLI', async () => {
    const statePath = join(directory(), 'state.sqlite')
    function backend() {
      const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), statePath, reuseConversations: false, allowToolBridge: true })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
      cleanup.push(server.closeBackend)
      const send = (body: unknown) => server.app.fetch(new Request('http://local/v1/messages', { method: 'POST', headers: { 'idempotency-key': 'persisted-call' }, body: JSON.stringify(body) }))
      return { runtime, server, send }
    }
    const body = { model: 'fixture-model', max_tokens: 100, tools: [{ name: 'lookup', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'lookup' }] }
    const original = backend()
    const first = await original.send(body)
    expect(first.status).toBe(200)
    const value = await first.json()
    await original.server.closeBackend(); cleanup.pop()
    const replacement = backend()
    replacement.runtime.verifyAccount = async () => { throw new Error('Saved calls must not invoke the CLI') }
    const second = await replacement.send(body)
    expect(second.headers.get('x-meridian-response-replayed')).toBe('true')
    expect(await second.json()).toEqual(value)
    expect(replacement.runtime.runs.size).toBe(0)
  })
  it('returns the saved answer after restart with no CLI/preflight, hooks or duplicate usage', async () => {
    const statePath = join(directory(), 'state.sqlite')
    let hookCalls = 0
    function backend() {
      const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), statePath, reuseConversations: false, allowToolBridge: true, plugins: [{ name: 'observe', onResponse: () => { hookCalls++ } }] })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
      cleanup.push(server.closeBackend)
      const send = (body: unknown, key = 'owner') => server.app.fetch(new Request('http://local/v1/messages', { method: 'POST', headers: { 'x-api-key': key }, body: JSON.stringify(body) }))
      return { runtime, server, send }
    }
    const original = backend(), body = request()
    const result = await original.send(body)
    expect(result.status).toBe(200)
    const value = await result.json()
    expect(hookCalls).toBe(1)
    await original.server.closeBackend()
    expect(original.runtime.settling.size).toBe(0)
    expect(original.runtime.stateError).toBeUndefined()
    cleanup.pop()
    const replacement = backend()
    const recorded = replacement.runtime.requests.length
    replacement.runtime.verifyAccount = async () => { throw new Error('Replay must never invoke CLI preflight') }
    const replay = await replacement.send(body)
    expect(replay.status).toBe(200)
    expect(replay.headers.get('x-meridian-response-replayed')).toBe('true')
    expect(await replay.json()).toEqual(value)
    const stream = await replacement.send({ ...body, stream: true })
    expect(await stream.text()).toContain('PRIVATE_RECEIPT')
    expect(hookCalls).toBe(1)
    expect(replacement.runtime.requests.length).toBe(recorded)
    expect((await replacement.send(body, 'stranger')).status).toBe(409)
    expect((await replacement.send({ ...body, max_tokens: 200 })).status).toBe(409)
  })
})
