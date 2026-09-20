import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'
import { AgState } from '../proxy/backends/antigravityState'
import { AgResponseStore, agResponseScope } from '../proxy/backends/antigravityResponses'
import { agOpenai } from '../proxy/backends/antigravityOpenai'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'
const roots: string[] = [], closing: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
  // Finalize native wrappers after a turn of the event loop. Keep removal an
  // assertion: retries are bounded and a retained handle still fails the test.
  for (const root of roots.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      if (process.platform === 'win32') { await new Promise(resolve => setTimeout(resolve, 50)); Bun.gc(true) }
      try { await rm(root, { recursive: true, force: true }); break }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 9 || !(error instanceof Error && 'code' in error && ['EBUSY','EPERM','ENOTEMPTY'].includes(String(error.code)))) {
          if (process.platform === 'win32' && attempt >= 9) {
            // Use production Node's filesystem implementation for the final
            // removal assertion when Bun's recursive rm still reports EBUSY.
            // This must remove the directory or reject; no leaked fixture is ignored.
            await promisify(execFile)('node', ['--input-type=module', '-e', "import {rm} from 'node:fs/promises';await rm(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:100})", root], {timeout:10000})
            break
          }
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  }
})
const root = () => { const path = mkdtempSync(join(tmpdir(), 'agy-state-test-')); roots.push(path); return path }
const scope = agResponseScope(new Headers())
const response = { id: 'r', output: [], status: 'completed' }
function fixture(path?: string) {
  const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), allowToolBridge: true, statePath: path })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  closing.push(server.closeBackend)
  return { runtime, server, post: (body: unknown) => server.app.fetch(new Request('http://local/v1/responses', { method: 'POST', body: JSON.stringify(body) })), get: (path: string, method = 'GET') => server.app.fetch(new Request('http://local/v1/responses/' + path, { method })) }
}
async function body(response: Response): Promise<Record<string, unknown>> { const value = await response.json() as Record<string, unknown>; expect(response.status, JSON.stringify(value)).toBe(200); return value }

describe('Antigravity durable state', () => {
  it('survives independent opens, respects scope/deletion, and leaves pending responses volatile', () => {
    const path = join(root(), 'state.sqlite')
    const db = new AgState(path), first = new AgResponseStore(undefined, undefined, db)
    first.put('one', scope, [{ role: 'user', content: 'receipt' }], response)
    first.put('pending', scope, [], { ...response, status: 'queued' })
    db.close()
    const reopened = new AgState(path), second = new AgResponseStore(undefined, undefined, reopened)
    expect(second.get('one', scope).input).toEqual([{ role: 'user', content: 'receipt' }])
    expect(() => second.get('one', 'other')).toThrow('not found')
    expect(() => second.get('pending', scope)).toThrow('not found')
    second.delete('one', scope)
    reopened.close()
    const again = new AgState(path)
    expect(again.get('responses', 'one', scope)).toBeUndefined()
    again.close()
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
  it('shares entry capacity across completed and pending responses, including after restart', () => {
    const path = join(root(), 'state.sqlite')
    const limits = { entries: 2, bytes: 4096, entryBytes: 2048, ttlMs: 60000 }
    const db = new AgState(path)
    try {
      const store = new AgResponseStore(limits, undefined, db)
      store.put('old', scope, [], response)
      store.put('new', scope, [], response)
      store.put('pending', scope, [], { status: 'queued' })
      expect(() => store.get('old', scope)).toThrow('not found')
      expect(store.get('new', scope).response).toEqual(response)
      expect(store.get('pending', scope).response.status).toBe('queued')
    } finally { db.close() }
    const reopened = new AgState(path)
    try {
      const store = new AgResponseStore(limits, undefined, reopened)
      expect(() => store.get('old', scope)).toThrow('not found')
      expect(() => store.get('pending', scope)).toThrow('not found')
      store.put('pending2', scope, [], { status: 'queued' })
      store.put('pending3', scope, [], { status: 'queued' })
      expect(() => store.get('new', scope)).toThrow('not found')
      expect(reopened.list('responses')).toHaveLength(0)
      store.put('completed', scope, [], response)
      expect(() => store.get('pending2', scope)).toThrow('not found')
      expect(store.get('pending3', scope).response.status).toBe('queued')
    } finally { reopened.close() }
  })
  it('shares serialized byte capacity across volatile and durable responses', () => {
    const db = new AgState(join(root(), 'state.sqlite'))
    try {
      const value = { status: 'completed', text: 'é'.repeat(100) }
      const bytes = Buffer.byteLength(JSON.stringify({ input: [], response: value }))
      const store = new AgResponseStore({ entries: 10, bytes: bytes * 2, entryBytes: bytes, ttlMs: 60000 }, undefined, db)
      store.put('old', scope, [], value)
      store.put('pending', scope, [], value, undefined, false)
      store.put('new', scope, [], value)
      expect(() => store.get('old', scope)).toThrow('not found')
      expect(db.get('responses', 'old', scope)).toBeUndefined()
      expect(store.get('pending', scope).response).toEqual(value)
      expect(store.get('new', scope).response).toEqual(value)
    } finally { db.close() }
  })
  it('replaces durable snapshots with volatile failures without resurrecting success', () => {
    const path = join(root(), 'state.sqlite'), db = new AgState(path)
    try {
      const store = new AgResponseStore(undefined, undefined, db)
      store.put('job', scope, [], response)
      store.put('job', scope, [], { status: 'failed' }, undefined, false)
      expect(store.get('job', scope).response.status).toBe('failed')
      expect(() => store.get('job', 'other')).toThrow('not found')
    } finally { db.close() }
    const reopened = new AgState(path)
    try { expect(() => new AgResponseStore(undefined, undefined, reopened).get('job', scope)).toThrow('not found') }
    finally { reopened.close() }
  })
  it('releases shared capacity on expiry, replacement and deletion', () => {
    const db = new AgState(join(root(), 'state.sqlite'))
    let now = Date.now()
    try {
      const store = new AgResponseStore({ entries: 2, bytes: 4096, entryBytes: 2048, ttlMs: 1000 }, () => now, db)
      store.put('expired', scope, [], response)
      now += 1001
      store.put('pending', scope, [], { status: 'queued' })
      store.put('live', scope, [], response)
      expect(db.get('responses', 'expired', scope)).toBeUndefined()
      store.put('pending', scope, [], response)
      expect(store.get('live', scope).response).toEqual(response)
      store.delete('pending', scope)
      store.put('third', scope, [], response)
      expect(store.get('live', scope).response).toEqual(response)
      expect(store.get('third', scope).response).toEqual(response)
    } finally { db.close() }
  })
  it('persists only exact interrupted continuation eligibility across runtime restart', async () => {
    const path = join(root(), 'state.sqlite')
    const first = fixture(path)
    const request = parseAgRequest({ model: 'fixture-model', max_tokens: 100, tools: [], messages: [
      { role: 'user', content: 'lookup' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'completed', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed', content: 'receipt' }] },
    ] })
    first.runtime.rememberConsumedTool('completed')
    first.runtime.rememberInterruptedContinuation(request)
    await first.server.closeBackend()
    const second = fixture(path)
    expect(second.runtime.hasConsumedTool('completed')).toBe(true)
    expect(second.runtime.canRetryContinuation(request)).toBe(true)
    expect(second.runtime.canRetryContinuation({ ...request, system: 'changed' })).toBe(false)
    second.runtime.forgetInterruptedContinuation(request)
    await second.server.closeBackend()
    const third = fixture(path)
    expect(third.runtime.canRetryContinuation(request)).toBe(false)
    expect(third.runtime.hasConsumedTool('completed')).toBe(true)
  })
  it('bounds persistent records and prunes expiry', () => {
    const db = new AgState(join(root(), 'state.sqlite'))
    db.put('x', 'expired', '', '{}', Date.now() - 1, 2, 100)
    db.put('x', 'first', '', 'a'.repeat(40), Date.now() + 10000, 2, 100)
    db.put('x', 'second', '', 'b'.repeat(40), Date.now() + 10000, 2, 100)
    db.put('x', 'third', '', 'c'.repeat(40), Date.now() + 10000, 2, 100)
    expect(db.list('x')).toEqual(['c'.repeat(40), 'b'.repeat(40)])
    expect(db.get('x', 'expired', '')).toBeUndefined()
    db.close()
  })
})

describe('Antigravity OpenAI expanded tool and media contracts', () => {
  it('preserves custom/namespaced calls and forced selection without alias collisions', async () => {
    const seen: Record<string, unknown>[] = []
    const request = new Request('http://local/v1/responses', { method: 'POST' })
    const tools = [{ type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'patch', format: { type: 'text' } }] }]
    const result = await agOpenai(request, { model: 'fixture-model', input: 'edit', tools, tool_choice: { type: 'custom', namespace: 'files', name: 'patch' } }, true, async req => {
      seen.push(await req.json() as Record<string, unknown>)
      return Response.json({ content: [{ type: 'tool_use', id: 'call', name: 'files__patch', input: { input: 'exact\npatch\n' } }], stop_reason: 'tool_use', usage: {} })
    }, new AgResponseStore())
    expect(seen[0]!.tool_choice).toEqual({ type: 'tool', name: 'files__patch' })
    expect((await result.json() as { output: unknown[] }).output[0]).toMatchObject({ type: 'custom_tool_call', namespace: 'files', name: 'patch', input: 'exact\npatch\n' })
    await expect(agOpenai(request, { model: 'fixture-model', input: 'edit', tools: [...tools, { type: 'function', name: 'files__patch' }] }, true, async () => Response.json({}), new AgResponseStore())).rejects.toThrow('Ambiguous')
  })
  it('adapts OpenAI file and audio data into the admitted media path and stores original bytes', async () => {
    const store = new AgResponseStore()
    const source = 'data:text/plain;base64,' + Buffer.from('Receipt').toString('base64')
    let received: Record<string, unknown> = {}
    const output = await agOpenai(new Request('http://local/v1/responses'), { model: 'fixture-model', input: [{ role: 'user', content: [{ type: 'input_file', file_data: source, filename: 'receipt.txt' }, { type: 'input_audio', input_audio: { data: 'YQ==', format: 'wav' } }] }] }, true, async req => {
      received = await req.json() as Record<string, unknown>
      return Response.json({ content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', usage: {} })
    }, store)
    expect(JSON.stringify(received.messages)).toContain('"type":"document"')
    expect(JSON.stringify(received.messages)).toContain('"type":"audio"')
    const result = await output.json() as { id: string }
    expect(JSON.stringify(store.get(result.id, scope).input)).toContain(source)
    expect(JSON.stringify(store.get(result.id, scope).input)).not.toContain('meridian-attachment:')
  })
})

describe('Antigravity background failure cursors', () => {
  it('publishes cancellation beyond consumed deltas without retaining duplicate oversized history', async () => {
    const { AgResponseJobs } = await import('../proxy/backends/antigravityJobs')
    const store = new AgResponseStore(), jobs = new AgResponseJobs(store)
    const queued = jobs.start(scope, [], 'fixture', async signal => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","sequence_number":0}\n\ndata: {"type":"response.output_text.delta","sequence_number":7,"delta":"hello"}\n\n'))
      signal.addEventListener('abort', () => controller.error(new Error('cancelled')), {once:true})
    }})))
    const id = String(queued.id)
    for(let n=0;n<100 && store.get(id,scope).response.status==='queued';n++) await new Promise(resolve=>setTimeout(resolve,1))
    await jobs.cancel(id,scope)
    expect(store.get(id,scope).events).toHaveLength(1)
    const events = await (await jobs.stream(id,scope,7,new AbortController().signal)).text()
    expect(events).toContain('response.cancelled')
    expect(events).toContain('"sequence_number":8')
    await jobs.close()
  })
})

describe.skipIf(process.platform === 'win32')('Antigravity background and durable HTTP/CLI', () => {
  it('counts supported Responses input without dispatching the CLI', async () => {
    const { server, runtime } = fixture()
    const result = await body(await server.app.fetch(new Request('http://local/v1/responses/input_tokens', {method:'POST',body:JSON.stringify({model:'fixture-model',input:'hello'})})))
    expect(result.estimated).toBe(true)
    expect(runtime.runs.size).toBe(0)
    expect(runtime.cliVersion).toBe('')
  })
  it('reports native restoration disabled when conversation reuse is off', async () => {
    const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), statePath:join(root(),'state.sqlite'),reuseConversations:false })
    const server = createAntigravityServer({...DEFAULT_PROXY_CONFIG,backend:'antigravity'},runtime)
    closing.push(server.closeBackend)
    const health = await body(await server.app.fetch(new Request('http://local/health')))
    expect(health.capabilities).toMatchObject({persistentResume:false,conversationReuse:false})
  })
  it('polls background work, replays cursor events and paginates input', async () => {
    const { post, get } = fixture()
    const queued = await body(await post({ model: 'fixture-model', input: 'Hello', background: true }))
    expect(queued.status).toBe('queued')
    const id = String(queued.id)
    let completed: Record<string, unknown> = {}
    for (let n = 0; n < 100; n++) { completed = await body(await get(id)); if (completed.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 20)) }
    expect(completed.status).toBe('completed')
    const replay = await (await get(id + '?stream=true&starting_after=0')).text()
    expect(replay).toContain('response.completed')
    expect(replay).not.toContain('event: response.created')
    const items = await body(await get(id + '/input_items?order=asc&limit=1'))
    expect(items.has_more).toBe(false)
    expect(items.data).toHaveLength(1)
    expect((await get(id + '?starting_after=2')).status).toBe(400)
    expect((await post({ model: 'fixture-model', input: 'hello', background: true, store: false })).status).toBe(400)
  }, 30000)
  it('cancels a background model turn and prevents deletion from resurrecting it', async () => {
    const { post, get, runtime } = fixture()
    const queued = await body(await post({ model: 'fixture-model', input: 'HANG', background: true }))
    const id = String(queued.id)
    const cancelled = await body(await get(id + '/cancel', 'POST'))
    expect(cancelled.status).toBe('cancelled')
    expect((await get(id, 'DELETE')).status).toBe(200)
    expect((await get(id)).status).toBe(404)
    expect([...runtime.runs.values()].filter(run => run.active)).toHaveLength(0)
  }, 30000)
  it('restores response snapshots and request telemetry through a backend restart', async () => {
    const path = join(root(), 'state.sqlite')
    const first = fixture(path)
    const value = await body(await first.post({ model: 'fixture-model', input: 'Hello' }))
    await first.server.closeBackend()
    const second = fixture(path)
    expect(await body(await second.get(String(value.id)))).toEqual(value)
    expect(second.runtime.requests).toHaveLength(1)
    expect(second.runtime.totals.requests).toBe(1)
    const resumed = await body(await second.post({ model: 'fixture-model', previous_response_id: value.id, input: 'Again' }))
    expect(resumed.status).toBe('completed')
  }, 30000)
})

describe('Antigravity native restoration and provider extensions', () => {
  it('permits only one live owner for a persistent state path', () => {
    const path = join(root(), 'state.sqlite'), first = new AgState(path)
    expect(() => new AgState(path)).toThrow('already owned')
    first.close(); first.close()
    const next = new AgState(path); next.close()
  })
  it('persists consumed result IDs and scrubs alternate provider credentials', async () => {
    const path = join(root(), 'state.sqlite')
    const first = fixture(path)
    first.runtime.rememberConsumedTool('completed-client-call')
    await first.server.closeBackend()
    const second = fixture(path)
    expect(second.runtime.hasConsumedTool('completed-client-call')).toBe(true)
    expect(second.runtime.hasConsumedTool('different-call')).toBe(false)
    const saved = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'fixture-not-a-real-key'
    try {
      const runtime = new AntigravityRuntime()
      expect(runtime.childEnv.OPENAI_API_KEY).toBeUndefined()
      await runtime.close()
    } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved }
  })
  it.skipIf(process.platform === 'win32')('rejects alternate custom model providers', async () => {
    const saved = process.env.AGY_FIXTURE_CUSTOM
    process.env.AGY_FIXTURE_CUSTOM = '1'
    try { const { runtime } = fixture(); await expect(runtime.verifyAccount()).rejects.toThrow('custom model providers') }
    finally { if (saved === undefined) delete process.env.AGY_FIXTURE_CUSTOM; else process.env.AGY_FIXTURE_CUSTOM = saved }
  })
  it('loads only explicitly configured provider plugin modules', async () => {
    const { AgPlugins } = await import('../proxy/backends/antigravityPlugins')
    const path = join(root(), 'plugin.mjs')
    writeFileSync(path, 'export default {name:"file-plugin",onRequest:({request})=>({...request,system:"file extension"})}')
    const plugins = new AgPlugins([], [path])
    expect(await plugins.request({model:'fixture'},new AbortController().signal)).toEqual({model:'fixture',system:'file extension'})
    expect(plugins.list()[0]?.name).toBe('file-plugin')
  })
  it('releases state ownership when later initialization fails', () => {
    const path = join(root(), 'state.sqlite')
    const workspace = join(dirname(path), 'antigravity-workspaces-' + createHash('sha256').update(resolve(path)).digest('hex').slice(0,12))
    writeFileSync(workspace,'invalid workspace directory')
    expect(() => new AntigravityRuntime({statePath:path})).toThrow()
    const reopened = new AgState(path); reopened.close()
  })
  it.skipIf(process.platform === 'win32')('reports metadata probe exit information without dispatching a model', async () => {
    const saved = process.env.AGY_FIXTURE_CONFIG_EXIT
    process.env.AGY_FIXTURE_CONFIG_EXIT = '1'
    try { const { runtime } = fixture(); await expect(runtime.verifyAccount()).rejects.toThrow('exit=2'); expect(runtime.runs.size).toBe(0) }
    finally { if (saved === undefined) delete process.env.AGY_FIXTURE_CONFIG_EXIT; else process.env.AGY_FIXTURE_CONFIG_EXIT = saved }
  })
  it('claims a native snapshot once and rejects histories with changed contracts', async () => {
    const { AgNativeSessions } = await import('../proxy/backends/antigravitySessions')
    const { parseAgRequest } = await import('../proxy/backends/antigravityProtocol')
    const { mkdirSync } = await import('node:fs')
    const path = join(root(), 'state.sqlite'), state = new AgState(path)
    const sessions = new AgNativeSessions(state, path, {})
    const workspace = join(sessions.directory, 'conversation-test'); mkdirSync(workspace)
    const request = parseAgRequest({ model: 'fixture-model', messages: [{ role: 'user', content: 'first' }] })
    const history = [...request.messages, { role: 'assistant' as const, content: 'reply' }]
    sessions.save(request, history, { conversationId: '12345678-1234-4234-8234-123456789abc', workspace, count: history.length })
    expect(sessions.claim({ ...request, system: 'changed', messages: [...history, { role: 'user', content: 'next' }] })).toBeUndefined()
    expect(sessions.claim({ ...request, messages: [...history, { role: 'user', content: 'next' }] })?.workspace).toBe(workspace)
    expect(sessions.claim({ ...request, messages: [...history, { role: 'user', content: 'next' }] })).toBeUndefined()
    state.close()
  })
  it('validates provider plugins and isolates observer mutation from the response', async () => {
    const { AgPlugins } = await import('../proxy/backends/antigravityPlugins')
    const plugins = new AgPlugins([{ name: 'test', onRequest({request}) { return { ...Object(request), system: 'injected' } }, onResponse({response}) { Object(response).content = 'changed' } }])
    const signal = new AbortController().signal
    expect(await plugins.request({ model: 'fixture' }, signal)).toEqual({ model: 'fixture', system: 'injected' })
    const response = { content: 'original' }; await plugins.observe('onResponse', response, signal)
    expect(response.content).toBe('original')
    await expect(new AgPlugins([{ name: 'same' }, { name: 'same' }]).init()).rejects.toThrow('Duplicate')
  })
  it('enforces regex grammars before client dispatch and rejects unsafe Lark imports', async () => {
    const { AgGrammars } = await import('../proxy/backends/antigravityGrammar')
    const { parseAgRequest } = await import('../proxy/backends/antigravityProtocol')
    const request = parseAgRequest({ model: 'fixture', messages: [{role:'user',content:'hello'}], meridian_tool_grammars: { custom: {syntax:'regex',definition:'[A-Z]{3}'} } })
    const grammars = new AgGrammars(request, new AbortController().signal)
    await grammars.prepare(); await grammars.validate('custom', {input:'ABC'})
    await expect(grammars.validate('custom', {input:'ABC\n'})).rejects.toThrow('violates')
    await expect(grammars.validate('custom', {input:'abcd'})).rejects.toThrow('violates')
    const imports = new AgGrammars({ ...request, meridian_tool_grammars: { custom: { syntax: 'lark', definition: '%import /private/secret\nstart: "x"' } } }, new AbortController().signal)
    await expect(imports.prepare()).rejects.toThrow('imports are limited')
  })
})
