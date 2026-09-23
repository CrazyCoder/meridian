import type { AgResponseEvent } from './antigravityJobs'
import type { AgState } from './antigravityState'
import { createHash } from 'node:crypto'
import { AntigravityError } from './antigravityProtocol'

/** Local Responses compatibility state, separate from native CLI conversation ownership. */
export class AgResponseStore {
  private readonly entries = new Map<string, { scope: string; json?: string; bytes: number; expires: number }>()
  private bytes = 0
  constructor(private readonly limits = { entries: 256, bytes: 64 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, ttlMs: 30 * 60_000 }, private readonly now = Date.now, private readonly state?: AgState, private readonly kind = 'responses') {
    // One oldest-first ledger covers both volatile payloads and durable metadata.
    // Rebuild it before admitting new work after a restart, without loading bodies.
    for (const record of state?.records(this.kind) ?? []) {
      this.entries.set(record.id, record)
      this.bytes += record.bytes
    }
    this.prune()
    this.trim()
  }

  private trim() {
    while (this.entries.size > this.limits.entries || this.bytes > this.limits.bytes) this.remove(this.entries.keys().next().value!)
  }

  private remove(id: string) {
    const entry = this.entries.get(id)
    if (entry) { this.state?.delete(this.kind, id, entry.scope); this.bytes -= entry.bytes; this.entries.delete(id) }
  }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id)
  }
  put(id: string, scope: string, input: unknown[], response: Record<string, unknown>, events?: AgResponseEvent[], durable = true) {
    const json = JSON.stringify({ input, response, events })
    const bytes = Buffer.byteLength(json)
    if (bytes > this.limits.entryBytes || bytes > this.limits.bytes) throw new AntigravityError('Stored response exceeds the local storage budget; retry with store: false and full history', 413)
    this.prune()
    this.remove(id)
    while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) this.remove(this.entries.keys().next().value!)
    const expires = this.now() + this.limits.ttlMs
    const persist = durable && this.state && !['queued', 'in_progress'].includes(String(response.status))
    if (persist) this.state!.put(this.kind, id, scope, json, expires, this.limits.entries, this.limits.bytes)
    this.entries.set(id, { scope, json: persist ? undefined : json, bytes, expires })
    this.bytes += bytes
  }
  get(id: string, scope: string): { input: unknown[]; response: Record<string, unknown>; events?: AgResponseEvent[] } {
    this.prune()
    const entry = this.entries.get(id)
    const json = entry?.scope === scope ? entry.json ?? this.state?.get(this.kind, id, scope) : undefined
    if (!json) throw new AntigravityError('Response not found: it may be unstored, deleted, expired, evicted or outside this storage/credential scope', 404, 'not_found_error')
    // Serialization isolates forks and prevents callers from mutating saved history.
    return JSON.parse(json) as { input: unknown[]; response: Record<string, unknown>; events?: AgResponseEvent[] }
  }
  delete(id: string, scope: string) {
    this.get(id, scope)
    this.remove(id)
    return { id, object: 'response', deleted: true }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}

/** Match auth header precedence; never retain raw credentials in the response store. */
export function agResponseScope(headers: Headers): string {
  const bearer = headers.get('authorization')
  const key = headers.get('x-api-key') || (bearer?.startsWith('Bearer ') ? bearer.slice(7) : '')
  return createHash('sha256').update(key || '').digest('hex')
}
