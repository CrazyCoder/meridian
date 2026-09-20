import { randomUUID } from 'node:crypto'
import { AntigravityError, type AgBlock } from './antigravityProtocol'

/** Lossless wire-format adaptation; actual decoding runs under runtime admission. */
export class AgOpenaiMedia {
  private readonly blocks = new Map<string, AgBlock>()
  private placeholder(block: AgBlock) {
    const text = 'meridian-attachment:' + randomUUID()
    this.blocks.set(text, block)
    return text
  }
  audio(data: string, format: string) {
    return this.placeholder({ type: 'audio', source: { type: 'base64', media_type: format === 'wav' ? 'audio/wav' : 'audio/mpeg', data } })
  }
  file(data: string, title?: string) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(data)
    if (!match) throw new AntigravityError('input_file requires a base64 data URL with its media type')
    const mime = match[1], bytes = match[2]!
    if (mime === 'application/pdf' || mime === 'text/plain') return this.placeholder({ type: 'document', title, source: { type: 'base64', media_type: mime, data: bytes } })
    if (mime === 'audio/wav' || mime === 'audio/mpeg' || mime === 'audio/mp4' || mime === 'audio/ogg' || mime === 'audio/flac') return this.placeholder({ type: 'audio', source: { type: 'base64', media_type: mime, data: bytes } })
    if (mime === 'video/mp4' || mime === 'video/webm' || mime === 'video/quicktime') return this.placeholder({ type: 'video', source: { type: 'base64', media_type: mime, data: bytes } })
    throw new AntigravityError('Unsupported input_file media type: ' + mime)
  }
  restore(value: unknown): unknown {
    if (Array.isArray(value)) return value.flatMap(item => {
      if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
        return item.text.split(/(meridian-attachment:[a-f0-9-]{36})/g).filter(Boolean).map((text: string) => this.blocks.get(text) ?? { type: 'text', text })
      }
      return [this.restore(item)]
    })
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (object.type === 'text' && typeof object.text === 'string') {
      const block = this.blocks.get(object.text)
      if (block) return block
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, this.restore(child)]))
  }
}
