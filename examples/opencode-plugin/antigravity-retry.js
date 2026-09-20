// OpenCode V1 plugin: use a provider named meridian-agy.
import { createHash } from 'node:crypto'
export default async function ({ client }) {
  return {
    config: async config => {
      const provider = config.provider?.['meridian-agy']
      if (!provider) return
      const options = provider.options ??= {}
      const upstream = options.fetch ?? globalThis.fetch
      options.fetch = (input, init) => streamSafely(upstream, input, init)
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'meridian-agy') return
      for (const key of Object.keys(output.headers)) if (key.toLowerCase() === 'idempotency-key') delete output.headers[key]
      // The header hook runs again on a processor retry. A random ID here
      // would regenerate the response. Use the public client's active message,
      // created before generation and retained across retries of that step.
      const result = await client.session.messages({ path: { id: input.sessionID } })
      if (result.error || !Array.isArray(result.data)) throw new Error('Cannot read OpenCode request identity')
      const active = result.data.filter(({ info }) => info.role === 'assistant' && info.parentID === input.message.id && info.agent === input.agent && info.modelID === input.model.id && info.providerID === input.model.providerID && !info.time?.completed)
      // Hidden one-shots and ambiguous concurrent steps must not share an ID.
      if (active.length !== 1) return
      output.headers['idempotency-key'] = createHash('sha256').update(JSON.stringify([input.sessionID, active[0].info.id])).digest('hex')
    },
  }
}

class DeliveryInterrupted extends Error {}
const maxBytes = 4 * 1024 * 1024
const encoder = new TextEncoder()
const wire = event => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)

async function streamSafely(upstream, input, init) {
  const abort = new AbortController()
  const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300000), ...(originalSignal ? [originalSignal] : [])])
  const response = await upstream(input, { ...init, signal })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
  const readers = new Set()
  const cancelReaders = () => { for (const reader of readers) void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', cancelReaders, { once: true })
  let cancelled = false
  const displayed = new Map()
  let message
  async function* chunks(response) {
    const reader = response.body.getReader()
    readers.add(reader)
    let bytes = 0
    try {
      signal.throwIfAborted()
      while (true) {
        let next
        try { next = await reader.read() }
        catch (error) { signal.throwIfAborted(); throw new DeliveryInterrupted(String(error)) }
        signal.throwIfAborted()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > maxBytes) throw new Error('Meridian response exceeds the 4 MiB client buffer')
        yield next.value
      }
    } finally {
      readers.delete(reader)
      // Preserve an original read failure if cancellation sees an errored reader.
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  async function* events(response) {
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of chunks(response)) {
      pending += decoder.decode(chunk, { stream: true })
      let match
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data) yield JSON.parse(data)
      }
    }
    pending += decoder.decode()
    if (pending.trim()) throw new DeliveryInterrupted('Meridian stream ended within an event')
  }
  async function recover() {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (typeof init?.body !== 'string') throw new Error('Meridian cannot recover a non-replayable request body')
    const body = JSON.parse(init.body)
    if (!headers.get('idempotency-key') && !body.meridian_request_id) throw new Error('Meridian recovery requires a request identity')
    headers.set('x-meridian-replay-only', 'true')
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json')
    const saved = await upstream(input, { ...init, signal, headers, body: JSON.stringify({ ...body, stream: false }) })
    if (!saved.ok || saved.headers.get('x-meridian-response-replayed') !== 'true') {
      await saved.body?.cancel()
      throw new Error(`Meridian saved-response recovery unavailable (${saved.status}); no tool calls released`)
    }
    const decoder = new TextDecoder()
    let json = ''
    for await (const chunk of chunks(saved)) json += decoder.decode(chunk, { stream: true })
    const answer = JSON.parse(json + decoder.decode())
    if (!answer.id || (message && answer.id !== message.id) || !Array.isArray(answer.content)) throw new Error('Meridian saved response identity changed')
    // Validate every visible prefix before exposing any recovered suffix or tool.
    for (const [index, shown] of displayed) {
      const block = answer.content[index]
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith(shown.text) || (shown.closed && block.text !== shown.text)) throw new Error('Meridian saved response differs from displayed text')
    }
    for (const block of answer.content) if (!['text', 'tool_use'].includes(block.type)) throw new Error('Meridian saved response contains an unsupported block')
    const result = []
    if (!message) result.push({ type: 'message_start', message: { ...answer, content: [], stop_reason: null, stop_sequence: null, usage: { ...answer.usage, output_tokens: 0 } } })
    for (const [index, block] of answer.content.entries()) {
      const shown = displayed.get(index)
      if (shown?.closed) continue
      if (!shown) result.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
      const text = block.type === 'text' ? block.text.slice(shown?.text.length ?? 0) : JSON.stringify(block.input)
      for (let offset = 0; offset < text.length; offset += 4096) result.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: text.slice(offset, offset + 4096) } : { type: 'input_json_delta', partial_json: text.slice(offset, offset + 4096) } })
      result.push({ type: 'content_block_stop', index })
    }
    result.push({ type: 'message_delta', delta: { stop_reason: answer.stop_reason, stop_sequence: answer.stop_sequence }, usage: answer.usage }, { type: 'message_stop' })
    return result
  }
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const held = []
        let holding = false, stopped = false
        try {
          for await (const event of events(response)) {
            if (stopped) throw new Error('Meridian sent data after message_stop')
            if (event.type === 'error') throw new Error(event.error?.message || 'Meridian stream failed')
            if (event.type === 'ping') continue
            if (event.type === 'message_start') {
              if (message || !event.message?.id) throw new Error('Invalid Meridian message identity')
              message = event.message
            }
            if (event.type === 'content_block_start' && event.content_block?.type !== 'text') holding = true
            if (event.type === 'message_delta' || event.type === 'message_stop') holding = true
            if (event.type === 'message_stop') stopped = true
            if (holding) held.push(event)
            else {
              if (event.type === 'content_block_start') displayed.set(event.index, { text: event.content_block.text || '', closed: false })
              if (event.type === 'content_block_delta') {
                const block = displayed.get(event.index)
                if (!block || event.delta?.type !== 'text_delta') throw new Error('Invalid Meridian text delta')
                block.text += event.delta.text
              }
              if (event.type === 'content_block_stop') {
                const block = displayed.get(event.index)
                if (!block) throw new Error('Invalid Meridian text block')
                block.closed = true
              }
              controller.enqueue(wire(event))
            }
          }
          if (!stopped) throw new DeliveryInterrupted('Meridian stream ended before message_stop')
          for (const event of held) controller.enqueue(wire(event))
        } catch (error) {
          signal.throwIfAborted()
          if (!(error instanceof DeliveryInterrupted)) throw error
          for (const event of await recover()) controller.enqueue(wire(event))
        }
        controller.close()
      } catch (error) {
        if (!cancelled) controller.error(error)
      } finally {
        signal.removeEventListener('abort', cancelReaders)
      }
    },
    cancel(reason) { cancelled = true; abort.abort(reason) },
  })
  const headers = new Headers(response.headers)
  headers.delete('content-encoding'); headers.delete('content-length')
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}
