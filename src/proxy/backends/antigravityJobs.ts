import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AntigravityError } from './antigravityProtocol'
import type { AgResponseStore } from './antigravityResponses'

export type AgResponseEvent = { type: string; sequence_number: number; [key: string]: unknown }
const eventSchema = z.object({ type: z.string(), sequence_number: z.number().int() }).passthrough()
export function responseEvents(response: Record<string, unknown>): AgResponseEvent[] {
  const events: AgResponseEvent[] = []
  const emit = (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields, sequence_number: events.length })
  emit('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } })
  const output = z.array(z.record(z.string(), z.unknown())).parse(response.output)
  for (const [index, item] of output.entries()) {
    emit('response.output_item.added', { output_index: index, item })
    emit('response.output_item.done', { output_index: index, item })
  }
  emit('response.' + response.status, { response })
  return events
}
export function agEventStream(events: AgResponseEvent[], startingAfter = -1): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of events) if (event.sequence_number > startingAfter) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

/** Background consumers own their cancellation; disconnecting a polling client does not abort agy. */
export class AgResponseJobs {
  private readonly jobs = new Map<string, { scope: string; abort: AbortController; done: Promise<void>; events: AgResponseEvent[] }>()
  constructor(private readonly store: AgResponseStore) {}
  start(scope: string, input: unknown[], model: string, execute: (signal: AbortSignal, id: string) => Promise<Response>): Record<string, unknown> {
    if (this.jobs.size >= 32) throw new AntigravityError('Too many background responses', 429, 'rate_limit_error')
    const id = 'resp_agy_' + randomUUID().replaceAll('-', '')
    const abort = new AbortController()
    const queued = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'queued', output: [], background: true, store: true }
    this.store.put(id, scope, input, queued)
    const events: AgResponseEvent[] = []
    const done = Promise.resolve().then(async () => {
      let bytes = 0
      try {
        const response = await execute(abort.signal, id)
        if (!response.ok || !response.body) throw new Error((await response.text()).slice(0, 8192))
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let pending = '', terminal = false
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break
            pending += next.value
            if (pending.length > 1024 * 1024) throw new Error('Background SSE frame exceeds 1 MiB')
            let boundary: number
            while ((boundary = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
              const line = frame.split('\n').find(line => line.startsWith('data: ')); if (!line) continue
              const raw: unknown = JSON.parse(line.slice(6))
              if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'error') throw new Error(JSON.stringify(raw))
              const event = eventSchema.parse(raw)
              bytes += Buffer.byteLength(line)
              if (bytes > 8 * 1024 * 1024 || events.length >= 50000) throw new Error('Background event log exceeds its budget')
              events.push(event)
              if (event.type === 'response.created') this.store.put(id, scope, input, { ...queued, status: 'in_progress' })
              if (event.type === 'response.completed' || event.type === 'response.incomplete') terminal = true
            }
          }
          if (!terminal || pending.trim()) throw new Error('Background response ended without a complete terminal event')
          const result = this.store.get(id, scope)
          this.store.put(id, scope, result.input, { ...result.response, background: true }, events)
        } catch (error) { await reader.cancel(error); throw error }
        finally { reader.releaseLock() }
      } catch (error) {
        const status = abort.signal.aborted ? 'cancelled' : 'failed'
        const result = { ...queued, status, error: status === 'failed' ? { code: 'server_error', message: String(error).slice(0, 8192) } : null }
        // Preserve the live cursor so a subscriber sees cancellation/failure even
        // after consuming earlier deltas.
        events.push({ type: 'response.' + status, sequence_number: events.length ? events[events.length - 1]!.sequence_number + 1 : 0, response: result })
        // Keep the terminal cursor without duplicating a full event log beside
        // a near-limit input history in the emergency failure snapshot.
        this.store.put(id, scope, input, result, events.slice(-1), false)
      } finally { this.jobs.delete(id) }
    })
    this.jobs.set(id, { scope, abort, done, events })
    return queued
  }
  async cancel(id: string, scope: string) {
    const existing = this.store.get(id, scope)
    if (existing.response.background !== true) throw new AntigravityError('Only background responses can be cancelled')
    const job = this.jobs.get(id)
    if (job?.scope === scope) { job.abort.abort(); await job.done }
    return this.store.get(id, scope).response
  }
  async close() {
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.abort.abort()
    await Promise.all(jobs.map(job => job.done))
  }
  async stream(id: string, scope: string, after: number, signal: AbortSignal): Promise<Response> {
    this.store.get(id, scope)
    const encoder = new TextEncoder()
    let cancelled = false
    // Poll the bounded shared log; each reader retains only its cursor.
    let sent = after
    return new Response(new ReadableStream<Uint8Array>({
      pull: async controller => {
        while (!cancelled && !signal.aborted) {
          const value = this.store.get(id, scope)
          const job = this.jobs.get(id)
          const available = job?.events ?? value.events ?? responseEvents(value.response)
          if (available.some(event => event.sequence_number > sent) || !job) {
            const events = available.filter(event => event.sequence_number > sent)
            if (events.length) {
              const event = events[0]!; sent = event.sequence_number
              controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
            } else controller.close()
            return
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        controller.close()
      },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }
}
