import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AntigravityError } from './antigravityProtocol'

export interface AntigravityPlugin {
  name: string
  /** Return an Anthropic-shaped request. Meridian validates it before dispatch. */
  onRequest?: (context: { provider: 'antigravity'; request: unknown; signal: AbortSignal }) => unknown | Promise<unknown>
  /** Observe-only: mutating the clone cannot change tools, replies or history. */
  onResponse?: (context: { provider: 'antigravity'; response: unknown; signal: AbortSignal }) => void | Promise<void>
  onTelemetry?: (context: { provider: 'antigravity'; metric: unknown; signal: AbortSignal }) => void | Promise<void>
}
const pluginSchema = z.object({ name: z.string().min(1).max(100),
  onRequest: z.custom<NonNullable<AntigravityPlugin['onRequest']>>(value => typeof value === 'function').optional(),
  onResponse: z.custom<NonNullable<AntigravityPlugin['onResponse']>>(value => typeof value === 'function').optional(),
  onTelemetry: z.custom<NonNullable<AntigravityPlugin['onTelemetry']>>(value => typeof value === 'function').optional(),
}).strict()

export class AgPlugins {
  private plugins: AntigravityPlugin[] = []
  private loading?: Promise<void>
  private active = 0
  private readonly failures = new Map<string, string>()
  constructor(private readonly configured: AntigravityPlugin[] = [], private readonly paths: string[] = []) {
    if (configured.length + paths.length > 16) throw new Error('At most 16 Antigravity plugins are supported')
  }
  init(): Promise<void> {
    this.loading ??= (async () => {
      const values: unknown[] = [...this.configured]
      for (const path of this.paths) values.push((await import(pathToFileURL(resolve(path)).href)).default)
      this.plugins = values.map(value => pluginSchema.parse(value))
      if (new Set(this.plugins.map(plugin => plugin.name)).size !== this.plugins.length) throw new Error('Duplicate Antigravity plugin names')
    })()
    return this.loading
  }
  list() { return this.plugins.map(plugin => ({ name: plugin.name, provider: 'antigravity', status: this.failures.has(plugin.name) ? 'error' : 'active', error: this.failures.get(plugin.name), hooks: ['onRequest', 'onResponse', 'onTelemetry'].filter(key => key in plugin) })) }
  private async invoke<T>(name: string, signal: AbortSignal, operation: (signal: AbortSignal) => T | Promise<T>, timeoutMs = 10000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs), combined = AbortSignal.any([signal, timeout])
    let abort: (() => void) | undefined
    try {
      return await Promise.race([Promise.resolve().then(() => { if (combined.aborted) throw new Error('Plugin cancelled'); return operation(combined) }), new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Antigravity plugin timed out or request was cancelled'))
        combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort()
      })])
    } catch (error) { this.failures.set(name, String(error).slice(0, 1000)); throw error }
    finally { if (abort) combined.removeEventListener('abort', abort) }
  }
  async request(body: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.active >= 32) throw new AntigravityError('Antigravity plugin admission is full', 429)
    this.active++
    try {
      await this.init()
      for (const plugin of this.plugins) if (plugin.onRequest) body = await this.invoke(plugin.name, signal, child => plugin.onRequest!({ provider: 'antigravity', request: structuredClone(body), signal: child }))
      return body
    } finally { this.active-- }
  }
  async observe(kind: 'onResponse' | 'onTelemetry', value: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    for (const plugin of this.plugins) {
      try {
        if (kind === 'onResponse' && plugin.onResponse) await this.invoke(plugin.name, signal, child => plugin.onResponse!({ provider: 'antigravity', response: structuredClone(value), signal: child }), 1000)
        if (kind === 'onTelemetry' && plugin.onTelemetry) await this.invoke(plugin.name, signal, child => plugin.onTelemetry!({ provider: 'antigravity', metric: structuredClone(value), signal: child }), 1000)
      } catch (error) { console.error(`[antigravity] Plugin ${plugin.name} observer failed:`, String(error)) }
    }
  }
}
