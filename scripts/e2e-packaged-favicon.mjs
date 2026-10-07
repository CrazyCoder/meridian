#!/usr/bin/env node
// Exercise the compiled Node server, where source-relative asset lookup failed.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'meridian-favicon-'))
for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_TELEMETRY_PERSIST: '0' })
const plugins = join(root, 'plugins'); mkdirSync(plugins)
const pluginConfigPath = join(root, 'plugins.json'); writeFileSync(pluginConfigPath, '{"plugins":[]}')
const { startProxyServer } = await import('../dist/server.js')
let proxy
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: plugins })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  for (const page of ['/', '/profiles', '/providers', '/plugins', '/settings', '/telemetry']) {
    const response = await fetch(url + page)
    assert.equal(response.status, 200, page)
    assert.match(await response.text(), /rel="icon" type="image\/svg\+xml" href="\/telemetry\/icon.svg"/)
  }
  const icon = await fetch(url + '/telemetry/icon.svg')
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/svg+xml'); assert.match(await icon.text(), /<svg/)
  console.log(JSON.stringify({ result: 'PASS', runtime: process.version, platform: `${process.platform}/${process.arch}`, pages: 6, iconStatus: icon.status }))
} finally { await proxy?.close() }
