import { object, text } from './core'
export const pluginCatalog = ['pi', 'opencode', 'hermes', 'openclaw'].map(client => ({
  id: `${client}-scrub`, package: `@rynfar/meridian-plugin-${client}-scrub`,
  title: ({ pi: 'Pi', opencode: 'OpenCode', hermes: 'Hermes', openclaw: 'OpenClaw' })[client] || client,
}))
export interface CatalogRelease { id: string; package: string; title: string; latest?: string; installed?: string }
export function catalogPlugin(value: unknown) {
  const plugin = pluginCatalog.find(item => item.id === value)
  if (!plugin) throw new Error('Choose a plugin from the catalog.')
  return plugin
}
/** Retain order, settings and unrelated entries when replacing a plugin. */
export function registerPlugin(source: string, entry: string, replaced: string[]) {
  const config = source ? object(JSON.parse(source)) : { plugins: [] }
  if (!Array.isArray(config.plugins) || config.plugins.some(item => !text(object(item).path))) throw new Error('Invalid plugin configuration. Repair it before installing plugins.')
  const plugins = config.plugins.map(object)
  const matches = (item: Record<string, unknown>) => item.path === entry || replaced.includes(text(item.path))
  const first = plugins.findIndex(matches)
  const updated = plugins.filter(item => !matches(item))
  updated.splice(first < 0 ? updated.length : first, 0, { ...(first < 0 ? {} : plugins[first]), path: entry, enabled: true })
  return JSON.stringify({ ...config, plugins: updated }, null, 2) + '\n'
}
