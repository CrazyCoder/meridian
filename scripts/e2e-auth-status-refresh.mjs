#!/usr/bin/env bun
// Real CLI auth + real HTTP sockets. Delays the real auth subprocess, never
// invents an authentication payload. Run on macOS/Linux with Claude logged in.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'meridian-auth-refresh-'))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'),
  MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_NO_UPDATE_CHECK: '1',
  MERIDIAN_CREDENTIALS_READONLY: '1',
})
const models = await import('../src/proxy/models.ts')
const realCli = await models.resolveClaudeExecutableAsync()
const version = spawnSync(realCli, ['--version'], { encoding: 'utf8', timeout: 15000 })
assert.equal(version.status, 0, 'Real Claude CLI version probe failed')
const marker = join(root, 'delay')
const calls = join(root, 'calls')
const wrapper = join(root, 'claude-probe')
// SDK invocations are forwarded without delay. Only auth-status is delayed.
writeFileSync(wrapper, `#!${process.execPath}\n` + `
import { existsSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  appendFileSync(${JSON.stringify(calls)}, 'auth\\n');
  if (existsSync(${JSON.stringify(marker)})) await new Promise(r => setTimeout(r, 2000));
}
const child = spawn(${JSON.stringify(realCli)}, args, {stdio:'inherit'});
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`)
chmodSync(wrapper, 0o700)
process.env.MERIDIAN_CLAUDE_PATH = wrapper
models.resetCachedClaudePath()
const { startProxyServer } = await import('../src/proxy/server.ts')
const instance = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const address = instance.server.address()
assert(address && typeof address === 'object')
const url = `http://127.0.0.1:${address.port}`
const count = () => readFileSync(calls, 'utf8').trim().split('\n').length
async function probe() {
  const started = performance.now()
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.status, 'healthy')
  assert.equal(body.auth.loggedIn, true, 'Requires actual Claude login')
  return performance.now() - started
}
try {
  await models.getClaudeAuthStatusAsync()
  await models.pendingAuthStatusRefresh?.()
  await probe()
  const before = count()
  writeFileSync(marker, '')
  models.expireAuthStatusCache()
  const started = performance.now()
  const latencyMs = await Promise.all(Array.from({ length: 5 }, probe))
  const elapsed = performance.now() - started
  const refresh = models.pendingAuthStatusRefresh?.()
  const requireBlocking = process.argv.includes('--expect-blocking')
  if (requireBlocking) {
    assert(elapsed >= 1900, 'Baseline failed to exhibit the delayed-auth health stall')
  } else {
    assert(Math.max(...latencyMs) < 1000, 'Warm health probe waited on delayed auth refresh')
    assert(refresh, 'No in-flight refresh remained after health responses')
    const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1000) })
    assert.equal(response.status, 200, 'Model discovery waited on delayed auth refresh')
  }
  await refresh
  assert.equal(count() - before, 1, 'Concurrent probes spawned duplicate auth checks')
  unlinkSync(marker)
  await probe()
  assert.equal(count() - before, 1, 'Fresh status unexpectedly spawned another check')
  console.log(JSON.stringify({ result: 'PASS', baselineBlocking: requireBlocking,
    platform: `${process.platform}/${process.arch}`, claude: version.stdout.trim(),
    latencyMs: latencyMs.map(ms => Math.round(ms)), authRefreshes: count() - before,
    actualLogin: true, artifact: root }))
} finally {
  await instance.close()
}
