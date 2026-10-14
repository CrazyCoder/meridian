#!/usr/bin/env bun
// Live: does readiness follow this instance's real Claude egress? (#1232, #1281)
//
// One real request reaches the model, so `/health` records an answer and
// `/readyz` passes. The egress is then cut for real: the SDK subprocess is
// pointed at a proxy port nothing listens on, so the real CLI fails to
// connect. After the configured number of connection failures `/readyz` must
// fail with the `upstream-claude` check while `/livez` stays up. With the
// egress restored and the hold ended by a short hold time, one real answer
// clears it again.
//
// Thresholds are shortened through the documented MERIDIAN_UPSTREAM_UNREACHABLE_*
// variables so the run takes about a minute. Costs two short real requests and
// needs a logged-in Claude subscription. Assertions are on status codes and the
// `/health` `upstream.claude` fields, never on the model's wording.
//
//   bun scripts/e2e-upstream-reachability-live.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-reachability-live-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[key]
const holdMs = 8000
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS: '1000', MERIDIAN_UPSTREAM_UNREACHABLE_MIN_FAILURES: '2',
  MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS: String(holdMs) })

const { startProxyServer } = await import('../src/proxy/server.ts')
const instance = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const address = instance.server.address()
assert(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const health = async () => (await (await fetch(`${base}/health`)).json()).upstream?.claude
// The isolated config has no profiles, so `/readyz` fails its separate
// profiles check here; only the upstream-claude line is this gate's subject.
const readyz = async () => {
  const response = await fetch(`${base}/readyz?verbose`)
  const text = (await response.text()).trim()
  return { status: response.status, upstream: /^\[([+-])\]upstream-claude/m.exec(text)?.[1] === '+' ? 'ok' : 'failed', text }
}
const livez = async () => (await fetch(`${base}/livez`)).status
async function ask() {
  const response = await fetch(`${base}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': `reach-live-${randomUUID()}` },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word READY.' }] }),
    signal: AbortSignal.timeout(240_000) })
  return { status: response.status, body: (await response.text()).slice(0, 300) }
}

const report = { result: 'RUNNING', model, platform: `${process.platform}/${process.arch}`, observed: {}, checks: [] }
const check = (ok, label, detail) => {
  report.checks.push({ ok: Boolean(ok), label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

try {
  console.log(`\n=== upstream reachability on real egress (model=${model}, ${report.platform}) ===`)
  const first = await ask()
  const reached = await health()
  report.observed.reached = { request: first.status, upstream: reached, readyz: await readyz() }
  check(first.status === 200 && reached?.state === 'ok' && reached?.lastReachedAt !== null && report.observed.reached.readyz.upstream === 'ok',
    'a real answer is recorded and readiness passes', JSON.stringify(report.observed.reached))

  // Cut the egress: every SDK subprocess spawned from here inherits a proxy
  // that refuses connections, and does not retry.
  Object.assign(process.env, { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', CLAUDE_CODE_MAX_RETRIES: '0' })
  const failures = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    failures.push(await ask())
    const state = await health()
    if (state?.state === 'unreachable') break
    await sleep(700)
  }
  const down = await health()
  const downReady = await readyz()
  report.observed.down = { requests: failures.map(row => row.status), upstream: down, readyz: downReady, livez: await livez() }
  check(failures.every(row => row.status !== 200), 'requests fail while the egress is cut', JSON.stringify(failures.map(row => row.status)))
  check(down?.state === 'unreachable' && down?.consecutiveFailures >= 2 && typeof down?.lastErrorKind === 'string',
    '/health reports the egress unreachable with the connection failure kind', JSON.stringify(down))
  check(downReady.status === 503 && downReady.upstream === 'failed' && report.observed.down.livez === 200,
    '/readyz fails on upstream-claude while /livez stays up', JSON.stringify({ readyz: downReady, livez: report.observed.down.livez }))
  check(failures.length <= 3, 'it took no more failures than the configured minimum plus one', `${failures.length}`)

  // Restore the egress and wait out the hold: readiness lets traffic back in
  // to probe, and one real answer clears the run.
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'CLAUDE_CODE_MAX_RETRIES']) delete process.env[key]
  await sleep(holdMs + 500)
  const probing = await health()
  const probingReady = await readyz()
  const recovered = await ask()
  const after = await health()
  report.observed.recovered = { probing, probingReady, request: recovered.status, upstream: after, readyz: await readyz() }
  check(probing?.state === 'probing' && probingReady.upstream === 'ok', 'after the hold readiness admits traffic to probe', JSON.stringify({ probing, probingReady }))
  check(recovered.status === 200 && after?.state === 'ok' && after?.consecutiveFailures === 0 && report.observed.recovered.readyz.upstream === 'ok',
    'one real answer clears the outage', JSON.stringify(report.observed.recovered))
  report.result = report.checks.every(row => row.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  report.result = 'FAIL'
  report.failure = String(error?.stack ?? error)
} finally {
  await instance.close()
  console.log(JSON.stringify(report))
  process.exitCode = report.result === 'PASS' ? 0 : 1
}
