// Actual Node HTTP ingress; only synthetic cookies/state, no OAuth/model calls.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
const root = await mkdtemp(join(tmpdir(), 'meridian-login-headers-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  CLAUDE_CONFIG_DIR: join(root, 'unlinked'), MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1',
  MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_SESSION_GC_INTERVAL_MS: '0' })
await mkdir(process.env.CLAUDE_CONFIG_DIR)
const { startProxyServer } = await import(pathToFileURL(resolve(process.env.E2E_SERVER_MODULE || 'dist/server.js')).href)
const baseline = process.env.E2E_EXPECT_HEADER_OVERFLOW === '1'
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true,
  profiles: [{ id: 'owned-api', type: 'api', apiKey: 'owned-synthetic' }], defaultProfile: 'owned-api' })
try {
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const base = 'http://127.0.0.1:' + proxy.server.address().port
  const cookie = 'owned=' + 'x'.repeat(20 * 1024)
  const ordinary = await fetch(base + '/livez')
  assert.equal(ordinary.status, 200)
  const live = await fetch(base + '/livez', { headers: { cookie } })
  assert.equal(live.status, baseline ? 431 : 200)
  const callback = await fetch(base + '/callback?state=owned-invalid', { headers: { cookie } })
  assert.equal(callback.status, baseline ? 431 : 410)
  if (!baseline) assert((await callback.text()).includes('expired'))
  const oversized = await fetch(base + '/livez', { headers: { cookie: 'owned=' + 'x'.repeat(40 * 1024) } })
  assert.equal(oversized.status, 431)
  console.log(JSON.stringify({ result: 'PASS', baseline, node: process.version, platform: process.platform,
    syntheticCookieBytes: cookie.length, ordinaryStatus: ordinary.status, liveStatus: live.status,
    callbackStatus: callback.status, aboveBudgetStatus: oversized.status, realOAuth: false, modelCalls: false }))
} finally { await proxy.close() }
