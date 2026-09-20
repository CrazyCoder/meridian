import { describe, expect, it } from 'bun:test'

type Fetch = typeof fetch
type Config = { provider?: Record<string, { options?: { fetch?: Fetch } }> }
async function wrapped(fetcher: Fetch) {
  const path = new URL('../../examples/opencode-plugin/antigravity-retry.js', import.meta.url).href
  const module: { default: (input: { client: object }) => Promise<{ config: (config: Config) => Promise<void> }> } = await import(path)
  const hooks = await module.default({ client: {} })
  const config: Config = { provider: { 'meridian-agy': { options: { fetch: fetcher } }, other: { options: { fetch: fetcher } } } }
  await hooks.config(config)
  expect(config.provider!.other!.options!.fetch).toBe(fetcher)
  return config.provider!['meridian-agy']!.options!.fetch!
}
const encode = (text: string) => new TextEncoder().encode(text)
const terminal = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const headers = { 'content-type': 'text/event-stream' }

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const start = frame({ type: 'message_start', message: { id: 'message-one' } })
const textStart = frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const delta = (text: string) => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const tool = frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-one', name: 'edit', input: {} } })
const request = { method: 'POST', headers: { 'idempotency-key': 'request-one' }, body: JSON.stringify({ stream: true, messages: [] }) }
const answer = (text = 'Hello 🪿 world') => ({ id: 'message-one', content: [{ type: 'text', text }, { type: 'tool_use', id: 'tool-one', name: 'edit', input: { value: 'once' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { output_tokens: 12 } })
const saved = (text?: string) => Response.json(answer(text), { headers: { 'x-meridian-response-replayed': 'true' } })
const parse = (text: string) => text.trim().split('\n\n').map(value => JSON.parse(value.split('\n').find(line => line.startsWith('data:'))!.slice(5)))

describe('OpenCode Antigravity selective delivery', () => {
  it('streams text immediately while holding tools and completion until EOF', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const fetcher = await wrapped(Object.assign(async () => new Response(source, { headers }), { preconnect: fetch.preconnect }))
    const response = await fetcher('http://localhost/v1/messages', request)
    const reader = response.body!.getReader()
    controller.enqueue(encode(start + textStart + delta('Hello')))
    const initial = []
    for (let index = 0; index < 3; index++) initial.push(new TextDecoder().decode((await reader.read()).value))
    expect(parse(initial.join('')).at(-1).delta.text).toBe('Hello')
    controller.enqueue(encode(tool + terminal))
    let delivered = false
    const next = reader.read().then(value => { delivered = true; return value })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(delivered).toBe(false)
    controller.close()
    expect(parse(new TextDecoder().decode((await next).value))[0].content_block.id).toBe('tool-one')
    await reader.cancel()
  })
  it('recovers changed chunk boundaries without repeating displayed Unicode text or tool calls', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    let calls = 0
    const fetcher = await wrapped(Object.assign(async (_input: Parameters<Fetch>[0], init?: RequestInit) => {
      if (++calls === 1) return new Response(source, { headers })
      expect(new Headers(init?.headers).get('x-meridian-replay-only')).toBe('true')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('request-one')
      expect(JSON.parse(String(init?.body)).stream).toBe(false)
      return saved()
    }, { preconnect: fetch.preconnect }))
    const response = await fetcher('http://localhost/v1/messages', request)
    const result = response.text()
    controller.enqueue(encode(start + textStart + delta('Hello 🪿')))
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.error(new TypeError('terminated'))
    const events = parse(await result)
    expect(events.filter(event => event.type === 'message_start')).toHaveLength(1)
    expect(events.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join('')).toBe('Hello 🪿 world')
    expect(events.filter(event => event.content_block?.type === 'tool_use')).toHaveLength(1)
    expect(events.at(-1).type).toBe('message_stop')
    expect(calls).toBe(2)
  })
  it('recovers a clean truncated EOF and discards the withheld tool prefix', async () => {
    let calls = 0
    const fetcher = await wrapped(Object.assign(async () => ++calls === 1 ? new Response(start + textStart + delta('Hello 🪿 world') + frame({ type: 'content_block_stop', index: 0 }) + tool, { headers }) : saved(), { preconnect: fetch.preconnect }))
    const events = parse(await (await fetcher('http://localhost/v1/messages', request)).text())
    expect(events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'text')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop' && event.index === 0)).toHaveLength(1)
    expect(events.filter(event => event.content_block?.type === 'tool_use')).toHaveLength(1)
  })
  it('refuses a changed visible prefix or an unavailable saved response', async () => {
    for (const recovered of [saved('different'), new Response('missing', { status: 404 })]) {
      let calls = 0
      const fetcher = await wrapped(Object.assign(async () => ++calls === 1 ? new Response(start + textStart + delta('Hello') + tool, { headers }) : recovered, { preconnect: fetch.preconnect }))
      await expect((await fetcher('http://localhost/v1/messages', request)).text()).rejects.toThrow()
      expect(calls).toBe(2)
    }
  })
  it('bounds memory and cancels oversized delivery without retrying', async () => {
    let cancelled = false, calls = 0
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    const fetcher = await wrapped(Object.assign(async () => { calls++; return new Response(source, { headers }) }, { preconnect: fetch.preconnect }))
    await expect((await fetcher('http://localhost/v1/messages', request)).text()).rejects.toThrow('4 MiB')
    expect(cancelled).toBe(true)
    expect(calls).toBe(1)
  })
  it('honors caller abort and consumer cancellation without recovery', async () => {
    for (const consumer of [false, true]) {
      const abort = new AbortController()
      let cancelled = false, calls = 0
      const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
      const fetcher = await wrapped(Object.assign(async () => { calls++; return new Response(source, { headers }) }, { preconnect: fetch.preconnect }))
      const response = await fetcher('http://localhost/v1/messages', { ...request, signal: abort.signal })
      if (consumer) await response.body!.cancel('user stopped')
      else { const pending = response.text(); abort.abort(new Error('user stopped')); await expect(pending).rejects.toThrow('user stopped') }
      expect(cancelled).toBe(true)
      expect(calls).toBe(1)
    }
  })
  it('preserves HTTP errors and nonstreaming responses', async () => {
    for (const response of [new Response('denied', { status: 403 }), new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })]) {
      const fetcher = await wrapped(Object.assign(async () => response, { preconnect: fetch.preconnect }))
      expect(await fetcher('http://localhost/v1/messages')).toBe(response)
    }
  })
})
