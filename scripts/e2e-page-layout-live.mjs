#!/usr/bin/env bun
// Actual HTTP app/pages/settings writes with 14 synthetic API profiles. No real
// credentials, SDK/model calls or startup refresh scheduler. Use the native
// collaborative browser; /fixture/frame supplies an exact CSS viewport.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
const root = mkdtempSync(join(tmpdir(), 'meridian-page-layout-live-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  CLAUDE_CONFIG_DIR: join(root, 'unlinked-default'), MERIDIAN_CREDENTIALS_READONLY: '1',
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0' })
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { mode: 0o700 })
const profiles = Array.from({ length: 14 }, (_, i) => ({ id: 'fixture-' + String(i + 1).padStart(2, '0'), type: 'api', apiKey: 'synthetic-only-' + i }))
writeFileSync(join(root, 'profiles.json'), JSON.stringify(profiles), { mode: 0o600 })
// API profile enrichment still consults the default native store for plan
// metadata. Isolate that boundary explicitly rather than adopting host data.
const credentials = await import('../src/proxy/tokenRefresh.ts')
const models = await import('../src/proxy/models.ts')
const sdk = await import('@anthropic-ai/claude-agent-sdk')
const sdkSpy = spyOn(sdk, 'query').mockImplementation(() => { throw new Error('UI fixture forbids SDK queries') })
const credentialSpy = spyOn(credentials, 'createPlatformCredentialStore').mockImplementation(() => ({
  read: async () => ({ claudeAiOauth: { accessToken: 'owned-synthetic-only', refreshToken: 'owned-synthetic-only',
    expiresAt: Date.now() + 3600000, scopes: [] } }),
  write: async () => { throw new Error('UI fixture forbids credential writes') },
}))
const authSpy = spyOn(models, 'getClaudeAuthStatusAsync').mockImplementation(async () => ({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }))
const { createProxyServer } = await import('../src/proxy/server.ts')
const { app } = createProxyServer({ profiles, defaultProfile: profiles[0].id, silent: true })
const paths = ['/', '/profiles', '/settings', '/telemetry', '/plugins', '/providers']
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.E2E_PORT || 42220), fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === '/fixture/frame') {
    const width = Number(url.searchParams.get('width') || 1280), path = url.searchParams.get('path') || '/'
    if (!Number.isInteger(width) || width < 320 || width > 2560 || !paths.includes(path)) return new Response('Invalid fixture viewport', { status: 400 })
    return new Response(`<iframe id="fixtureViewport" data-owned-fixture="page-layout" title="Synthetic Meridian viewport" style="border:0;width:${width}px;height:1000px" src="${path}"></iframe>`, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
  }
  assert(!['/v1/messages', '/messages', '/v1/responses', '/v1/chat/completions'].includes(url.pathname), 'This UI fixture must not call a model')
  return app.fetch(request)
} })
console.log(JSON.stringify({ ready: true, port: server.port, ownedRoot: root, profiles: profiles.length, syntheticOnly: true }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.stop(true); sdkSpy.mockRestore(); authSpy.mockRestore(); credentialSpy.mockRestore(); process.exit(0) })
