#!/usr/bin/env bun
// Actual app/settings I/O and standalone provider-page rendering; no models.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'meridian-layout-http-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  CLAUDE_CONFIG_DIR: join(root, 'unlinked'), MERIDIAN_API_KEY: 'owned-layout-key',
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_CREDENTIALS_READONLY: '1' })
const { createProxyServer } = await import('../src/proxy/server.ts')
const { createAntigravityServer } = await import('../src/proxy/backends/antigravity.ts')
const { DEFAULT_PROXY_CONFIG } = await import('../src/proxy/types.ts')
const { app } = createProxyServer({ silent: true })
const standalone = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity', silent: true })
const headers = { Authorization: 'Bearer owned-layout-key', Accept: 'text/html', 'Content-Type': 'application/json' }
const request = (path, method = 'GET', body, auth = true) => new Request('http://localhost' + path, {
  method, headers: auth ? headers : { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
try {
  assert.equal((await app.fetch(request('/settings/api/layout', 'GET', undefined, false))).status, 401)
  assert.equal((await app.fetch(request('/settings/api/layout', 'PUT', { layout: 'wide' }, false))).status, 401)
  assert.equal((await (await app.fetch(request('/settings/api/layout'))).json()).layout, 'contained')
  assert.equal((await app.fetch(request('/settings/api/layout', 'PUT', { layout: 'wide' }))).status, 200)
  assert.equal(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).layout, 'wide')
  const routes = []
  for (const path of ['/', '/profiles', '/settings', '/telemetry', '/plugins', '/providers']) {
    const response = await app.fetch(request(path)); assert.equal(response.status, 200)
    assert((await response.text()).includes('<html data-layout="wide"'))
    routes.push(path)
  }
  for (const path of ['/', '/providers']) {
    const response = await standalone.app.fetch(request(path)); assert.equal(response.status, 200)
    assert((await response.text()).includes('<html data-layout="wide"'))
  }
  for (const invalid of [{ layout: 'unknown' }, null, ['wide']]) assert.equal((await app.fetch(request('/settings/api/layout', 'PUT', invalid))).status, 400)
  assert.equal((await (await app.fetch(request('/settings/api/layout'))).json()).layout, 'wide')
  assert.equal((await app.fetch(request('/settings/api/layout', 'PUT', { layout: null }))).status, 200)
  assert(!Object.hasOwn(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')), 'layout'))
  assert.equal((await (await app.fetch(request('/settings/api/layout'))).json()).layout, 'contained')
  for (const path of routes) assert(!(await (await app.fetch(request(path))).text()).includes('<html data-layout'))
  console.log(JSON.stringify({ result: 'PASS', platform: `${process.platform}/${process.arch}`, bun: Bun.version,
    unauthenticatedGetStatus: 401, unauthenticatedPutStatus: 401, defaultContained: true, widePersisted: true,
    mainRoutesStamped: routes, standaloneAntigravityRoutesStamped: ['/', '/providers'], invalidInputsRefused: true,
    invalidPreservesWide: true, nullRemovesStoredField: true, resetRestoresAllPages: true, modelCalls: false }))
} finally { await standalone.closeBackend(); rmSync(root, { recursive: true, force: true }) }
