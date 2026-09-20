import { createHash } from 'node:crypto'
import { AgResponseStore } from './antigravityResponses'
import { AntigravityError, blocks, contractKey, historyKey, stable, type AgRequest, type AgCall } from './antigravityProtocol'
import type { AgState } from './antigravityState'

export interface AgCompletedAnswer {
  id: string
  type: string
  role: string
  model: string
  content: Array<{ type: 'text'; text: string } | AgCall>
  stop_reason: string
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

export function agRequestId(request: AgRequest, headers: Headers): string | undefined {
  const header = headers.get('idempotency-key'), body = request.meridian_request_id
  if (header !== null && body !== undefined && header !== body) throw new AntigravityError('Conflicting request IDs')
  const value = header ?? body
  if (value === undefined) return
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new AntigravityError('Request ID must contain 1–128 ASCII letters, digits, dots, underscores, colons or hyphens')
  return value
}

/** One budget covers implicit completed-result answers and explicitly identified requests. */
export class AgCompletedAnswers {
  private draining?: Promise<void>
  private readonly store: AgResponseStore
  private readonly active = new Map<string, { fingerprint: string; waiters: Set<() => void> }>()
  constructor(private readonly state?: AgState) {
    this.store = new AgResponseStore({ entries: 128, bytes: 16 * 1024 * 1024, entryBytes: 1024 * 1024, ttlMs: 30 * 60_000 }, undefined, state, 'completed-answers')
  }
  private fingerprint(request: AgRequest) {
    return createHash('sha256').update(stable([contractKey(request), historyKey(request.messages), request.tool_choice])).digest('hex')
  }
  private key(request: AgRequest, scope: string, requestId?: string) {
    return createHash('sha256').update(stable(requestId ? [scope, 'request', requestId] : [scope, contractKey(request), historyKey(request.messages), request.tool_choice])).digest('hex')
  }
  eligible(request: AgRequest) {
    return blocks(request.messages.at(-1)!).some(block => block.type === 'tool_result')
  }
  async wait(request: AgRequest, scope: string, requestId: string | undefined, signal: AbortSignal) {
    if (!requestId) return
    const active = this.active.get(this.key(request, scope, requestId))
    if (!active) return
    if (active.fingerprint !== this.fingerprint(request)) throw new AntigravityError('Request ID was reused with a different request', 409)
    if (active.waiters.size >= 128) throw new AntigravityError('Too many retries waiting for one request', 429, 'rate_limit_error')
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        active.waiters.delete(done); signal.removeEventListener('abort', abort)
        if (error) reject(error); else resolve()
      }
      const done = () => finish()
      const abort = () => finish(new AntigravityError('Request cancelled', 499, 'api_error'))
      active.waiters.add(done)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  drain(): Promise<void> {
    this.draining ??= Promise.all([...this.active.values()].map(active => new Promise<void>(resolve => active.waiters.add(resolve)))).then(() => undefined)
    return this.draining
  }

  claim(request: AgRequest, scope: string, requestId?: string): () => void {
    if (this.draining) throw new AntigravityError('Antigravity is shutting down', 503, 'api_error')
    if (!requestId) return () => undefined
    const key = this.key(request, scope, requestId)
    if (this.active.has(key)) throw new AntigravityError('Request already active', 409)
    if (this.active.size >= 128) throw new AntigravityError('Too many identified requests', 429, 'rate_limit_error')
    const fingerprint = this.fingerprint(request)
    const interrupted = this.state?.get('unfinished-requests', key, scope)
    if (interrupted) {
      if (interrupted !== fingerprint) throw new AntigravityError('Request ID was reused with a different request', 409)
      throw new AntigravityError('This request was interrupted by a service restart without a saved response. Its outcome is uncertain. Review client tool history and any external effects before starting a new turn; do not automatically retry with a new request ID.', 409)
    }
    // Refuse admission instead of evicting another unresolved recovery guard.
    if (this.state && this.state.records('unfinished-requests').length >= 128) throw new AntigravityError('Unfinished request recovery journal is full; retained guards expire after 30 minutes', 429, 'rate_limit_error')
    this.state?.put('unfinished-requests', key, scope, fingerprint, Date.now() + 30 * 60_000, 128, 65536)
    const active = { fingerprint, waiters: new Set<() => void>() }
    this.active.set(key, active)
    return () => {
      if (this.active.get(key) !== active) return
      try { this.state?.delete('unfinished-requests', key, scope) }
      finally {
        this.active.delete(key)
        for (const done of active.waiters) done()
      }
    }
  }

  get(request: AgRequest, scope: string, requestId?: string): AgCompletedAnswer | undefined {
    if (!requestId && !this.eligible(request)) return
    try {
      const saved = this.store.get(this.key(request, scope, requestId), scope)
      if ((requestId || saved.input.length) && saved.input[0] !== this.fingerprint(request)) throw new AntigravityError('Request ID was reused with a different request', 409)
      return saved.response as unknown as AgCompletedAnswer
    } catch (error) { if (!(error instanceof AntigravityError) || error.status !== 404) throw error }
  }
  put(request: AgRequest, scope: string, answer: AgCompletedAnswer, requestId?: string) {
    if (!requestId && !this.eligible(request)) return
    const input = [this.fingerprint(request)]
    if (Buffer.byteLength(JSON.stringify({ input, response: answer })) > 1024 * 1024) {
      if (requestId) throw new AntigravityError('Identified response exceeds the 1 MiB replay budget', 413)
      return
    }
    this.store.put(this.key(request, scope, requestId), scope, input, { ...answer })
  }
  clear() { this.store.clear() }
}

/** Reconstruct protocol events lazily, without retaining a second response buffer. */
export function replayAgAnswer(answer: AgCompletedAnswer, stream: boolean, headers: Record<string, string>): Response {
  const replayHeaders = { ...headers, 'x-meridian-response-replayed': 'true', 'cache-control': 'no-store' }
  if (!stream) return Response.json(answer, { headers: replayHeaders })
  function* frames() {
    yield { type: 'message_start', message: { ...answer, content: [], stop_reason: null, stop_sequence: null, usage: { ...answer.usage, output_tokens: 0 } } }
    for (const [index, block] of answer.content.entries()) {
      yield { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } }
      const text = block.type === 'text' ? block.text : JSON.stringify(block.input)
      for (let offset = 0; offset < text.length; offset += 4096) yield { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: text.slice(offset, offset + 4096) } : { type: 'input_json_delta', partial_json: text.slice(offset, offset + 4096) } }
      yield { type: 'content_block_stop', index }
    }
    yield { type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence }, usage: answer.usage }
    yield { type: 'message_stop' }
  }
  const iterator = frames(), encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next()
      if (next.done) { controller.close(); return }
      controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`))
    },
    cancel() { iterator.return() },
  }), { headers: { ...replayHeaders, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } })
}
