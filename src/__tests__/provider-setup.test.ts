import { describe, expect, it } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { providerSetupCommand, providerSetupHtml, providerSetupJs } from '../telemetry/providerSetup'

describe('provider client setup commands', () => {
  it('uses the actual service and independent Antigravity route for either client', () => {
    expect(providerSetupCommand('http://127.0.0.1:9876/', '/antigravity/v1/messages', 'pi', 'gemini-low')).toBe("meridian setup --antigravity --client pi --url 'http://127.0.0.1:9876/antigravity' --model 'gemini-low'")
    expect(providerSetupCommand('https://example.test/proxy/', '/v1/messages', 'opencode', 'gemini-high', 'LOCAL_KEY', true)).toBe("meridian setup --antigravity --client opencode --url 'https://example.test/proxy' --model 'gemini-high' --api-key-env LOCAL_KEY --set-default")
  })
  it('quotes shell-sensitive URL paths without evaluating them', () => {
    const command = providerSetupCommand("https://example.test/a'$(echo test)", '/v1/messages', 'pi', 'gemini-low')
    expect(command).toContain("--url 'https://example.test/a'\"'\"'$(echo%20test)'")
  })
  it('refuses unsupported endpoints, malformed models, API key values and credential-bearing service URLs', () => {
    for (const url of ['file:///tmp/service', 'https://name:secret@example.test', 'https://example.test/?key=secret', 'https://example.test/#token']) {
      expect(() => providerSetupCommand(url, '/v1/messages', 'pi', 'gemini-low')).toThrow()
    }
    expect(() => providerSetupCommand('http://localhost', '//elsewhere/v1/messages', 'pi', 'gemini-low')).toThrow('endpoint')
    expect(() => providerSetupCommand('http://localhost', '/v1/messages', 'pi', 'gemini;evil')).toThrow('model')
    expect(() => providerSetupCommand('http://localhost', '/v1/messages', 'pi', 'gemini', 'sk-secret-key')).toThrow('variable')
    expect(() => providerSetupCommand('http://localhost', '/v1/messages', 'unknown', 'gemini')).toThrow('Choose')
  })
  it('renders only validated account models and explains missing model data', () => {
    const html = providerSetupHtml(['bad<script>', 'gemini-test-high', 'gemini-test-low'], '/antigravity/v1/messages')
    expect(html).not.toContain('bad<script>')
    expect(html).toContain('value="gemini-test-low" selected')
    expect(html).toContain('OpenCode V1')
    expect(html).not.toContain('name="agy-default" checked')
    expect(providerSetupHtml(undefined, '/v1/messages')).toContain('when account models load')
  })
  it('serializes executable browser JavaScript without runtime module dependencies', () => {
    const context = { URL, document: { addEventListener() {} } }
    runInNewContext(providerSetupJs, context)
    expect(runInNewContext("meridianSetupCommand('http://localhost:3456', '/antigravity/v1/messages', 'opencode', 'gemini-low')", context)).toBe(providerSetupCommand('http://localhost:3456', '/antigravity/v1/messages', 'opencode', 'gemini-low'))
  })
})

import { clientSetupClipboardCommand } from '../../apps/desktop/src/clientSetup'
import { defaults } from '../../apps/desktop/src/core'
describe('desktop native setup clipboard boundary', () => {
  const state = { preferences: { ...defaults, mode: 'attached' as const, endpoint: 'http://localhost:3456' }, providers: { fetchedAt: 0, providers: [{ id: 'antigravity' as const, name: 'Antigravity', enabled: true, status: 'healthy', endpoint: '/antigravity/v1/messages', models: ['gemini-low'], accounts: [] }] } }
  it('reconstructs the command from service state and validated choices', () => {
    expect(clientSetupClipboardCommand(state, {client:'pi',model:'gemini-low',keyEnv:'LOCAL_KEY',setDefault:true,command:'injected'})).toBe(providerSetupCommand(state.preferences.endpoint, '/antigravity/v1/messages', 'pi', 'gemini-low', 'LOCAL_KEY', true))
    expect(clientSetupClipboardCommand({...state, preferences:{...defaults,port:8765}}, {client:'opencode',model:'gemini-low'})).toContain("--url 'http://127.0.0.1:8765/antigravity'")
  })
  it('rejects stale model choices, arbitrary text and invalid controls', () => {
    expect(() => clientSetupClipboardCommand(state, 'arbitrary text')).toThrow('models')
    expect(() => clientSetupClipboardCommand(state, {client:'pi',model:'unknown'})).toThrow('models')
    expect(() => clientSetupClipboardCommand(state, {client:'pi',model:'gemini-low',setDefault:'yes'})).toThrow('selection')
    expect(() => clientSetupClipboardCommand({...state,providers:undefined}, {client:'pi',model:'gemini-low'})).toThrow('models')
  })
})
