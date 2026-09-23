import { providerSetupCommand } from '../../../src/telemetry/providerSetup'
import { object, text } from './core'
import type { DesktopState } from './contracts'

/** Rebuild copied commands from trusted service state, never arbitrary renderer text. */
export function clientSetupClipboardCommand(state: Pick<DesktopState, 'preferences' | 'providers'>, value: unknown): string {
  const input = object(value), model = text(input.model)
  const provider = state.providers?.providers.find(provider => provider.id === 'antigravity' && provider.enabled)
  if (!provider?.models?.includes(model)) throw new Error('Refresh the Antigravity account models before copying setup.')
  if (input.setDefault !== undefined && typeof input.setDefault !== 'boolean') throw new Error('Invalid default selection.')
  const endpoint = state.preferences.mode === 'managed' ? `http://127.0.0.1:${state.preferences.port}` : state.preferences.endpoint
  return providerSetupCommand(endpoint, provider.endpoint, text(input.client), model, text(input.keyEnv).trim(), input.setDefault === true)
}
