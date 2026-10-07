// Actual bundled Node HTTP lifecycle; no model calls or host credential adoption.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
const port = Number(process.env.E2E_UPDATE_PORT ?? 0)
const keepOpen = process.env.E2E_KEEP_OPEN === '1'
const root = mkdtempSync(join(tmpdir(), 'meridian-update-live-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
const cache = join(root, 'cache.json'), credentialDir = join(root, 'credentials')
mkdirSync(credentialDir, { mode: 0o700 })
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  CLAUDE_CONFIG_DIR: credentialDir, MERIDIAN_UPDATE_CHECK_PATH: cache, MERIDIAN_TELEMETRY_PERSIST: '0' })
let hits = 0
const registry = createServer((_request, response) => { hits++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ latest: '1.99.0' })) })
registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
process.env.MERIDIAN_UPDATE_CHECK_URL = `http://127.0.0.1:${registry.address().port}`
const require = createRequire(import.meta.url)
const { serve } = require('@hono/node-server')
const { createProxyServer } = await import('../dist/server.js')
const { app } = createProxyServer({ silent: true, version: '1.79.0', profiles: [{ id: 'update-verification', claudeConfigDir: credentialDir }] })
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }); await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const state = async () => (await fetch(base + '/settings/api/updates')).json()
const toggle = async value => { const response = await fetch(base + '/settings/api/updates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkForUpdates: value }) }); assert.equal(response.status, 200); return response.json() }
try {
  assert.equal((await state()).enabled, false); await new Promise(r => setTimeout(r, 100)); assert.equal(hits, 0); assert.equal(existsSync(cache), false)
  const enabled = await toggle(true); assert.equal(enabled.build.latest, '1.99.0'); assert.equal(enabled.build.updateAvailable, true); assert.equal(hits, 1)
  assert.equal((await toggle(false)).build.latest, undefined)
  assert.equal((await toggle(true)).build.latest, '1.99.0'); assert.equal(hits, 1)
  await toggle(false); process.env.MERIDIAN_NO_UPDATE_CHECK = '1'; assert.equal((await toggle(true)).enabled, false); assert.equal(hits, 1)
  delete process.env.MERIDIAN_NO_UPDATE_CHECK
  await toggle(false); delete process.env.MERIDIAN_UPDATE_CHECK_URL; process.env.MERIDIAN_UPDATE_CHECK_PATH = join(root, 'real-registry-cache.json')
  const real = await toggle(true); assert.match(real.build.latest, /^\d+\.\d+\.\d+/)
  await toggle(false)
  console.log(JSON.stringify({ result: 'PASS', platform: `${process.platform}/${process.arch}`, offHits: 0, enabledHits: hits,
    disabledClearsLatest: true, cacheReenableAvoidsNetwork: true, environmentOptOut: true, realRegistryLatest: real.build.latest, url: base, isolated: true }))
  if (keepOpen) await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
} finally { server.close(); registry.close(); rmSync(root, { recursive: true, force: true }) }
process.exit(0)
