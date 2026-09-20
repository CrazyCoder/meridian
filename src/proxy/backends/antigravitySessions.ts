import { mkdirSync, lstatSync, realpathSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AntigravityOptions } from '../types'
import { contractKey, historyKey, hasAgImages, type AgRequest, type AgMessage } from './antigravityProtocol'
import type { AgState } from './antigravityState'
const snapshot = z.object({ conversationId: z.string().uuid(), workspace: z.string(), count: z.number().int().positive() })
export type AgNativeSnapshot = z.infer<typeof snapshot>

/** Only completed, joined CLI processes enter this cache; claiming consumes the mapping. */
export class AgNativeSessions {
  readonly directory: string
  private readonly active = new Set<string>()
  constructor(private readonly state: AgState, path: string, private readonly options: AntigravityOptions) {
    this.directory = resolve(dirname(path), 'antigravity-workspaces-' + createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12))
    // Validate existing workspace roots before recursive mkdir. In particular,
    // do not pass a regular file through the Windows mkdir failure path.
    try {
      const existing = lstatSync(this.directory)
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Antigravity workspace root must be a real directory')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    }
    this.directory = realpathSync(this.directory)
    this.prune(true)
  }
  register(workspace: string, pid = process.pid) {
    this.active.add(workspace)
    writeFileSync(join(workspace, '.meridian-owner.json'), JSON.stringify({ pid }), { mode: 0o600 })
  }
  private alive(workspace: string): boolean {
    try {
      const owner = JSON.parse(readFileSync(join(workspace, '.meridian-owner.json'), 'utf8')) as { pid?: unknown }
      if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true
      try { process.kill(owner.pid, 0); return true }
      catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH') }
    } catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ENOENT') }
  }
  release(workspace: string) { this.active.delete(workspace); this.prune() }
  private prune(startup = false) {
    // Only this state's own disposable workspaces. Active work never participates.
    const retained = new Set(this.state.list('native-sessions').map(value => snapshot.parse(JSON.parse(value)).workspace))
    for (const name of readdirSync(this.directory)) {
      const path = join(this.directory, name)
      if (name.startsWith('conversation-') && !this.active.has(path) && !retained.has(path) && !this.alive(path) && Date.now() - statSync(path).mtimeMs > (startup ? 30 * 60_000 : 10000)) rmSync(path, { recursive: true, force: true })
    }
  }
  eligible(request: AgRequest) {
    return this.options.reuseConversations !== false && !this.options.allowNativeBrowser && !this.options.allowNativeSubagents && !request.output_config?.format && !request.stop_sequences?.length && !hasAgImages(request.messages)
  }
  private key(request: AgRequest, messages: AgMessage[]) { return createHash('sha256').update(contractKey(request) + historyKey(messages)).digest('hex') }
  claim(request: AgRequest): AgNativeSnapshot | undefined {
    if (!this.eligible(request)) return
    const count = request.messages.findLastIndex(message => message.role === 'assistant') + 1
    if (!count || count === request.messages.length || !request.messages.slice(count).every(message => message.role === 'user')) return
    const json = this.state.take('native-sessions', this.key(request, request.messages.slice(0, count)), '')
    if (!json) return
    const value = snapshot.parse(JSON.parse(json))
    if (value.count !== count) throw new Error("Invalid native resume history length")
    if (dirname(value.workspace) !== this.directory || !value.workspace.startsWith(join(this.directory, 'conversation-'))) throw new Error('Invalid native resume workspace')
    this.register(value.workspace)
    return value
  }
  save(request: AgRequest, history: AgMessage[], value: AgNativeSnapshot) {
    this.state.put('native-sessions', this.key(request, history), '', JSON.stringify(value), Date.now() + 30 * 60_000, 128, 1024 * 1024)
  }
}
