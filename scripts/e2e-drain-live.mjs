#!/usr/bin/env bun
// Live: does `POST /drain` give a supervisor an idle window under overlapping
// real traffic, without losing the request that arrives during it? (#1224, #1282)
//
// A real model request is started and left streaming. A drain is opened, then
// a second real request arrives. With the route:
//   - a keyless `POST /drain` is refused and the keyed one starts the drain;
//   - the second request is held: `/inflight` shows `drain.held: 1` and it is
//     not in `total`, and no SDK query has started for it;
//   - the first stream finishes untouched and `total` reaches 0 while the
//     second is still held, which is the window a supervisor waits for;
//   - `DELETE /drain` releases the held request and it completes normally.
// `--expect-baseline` is for a build without the route: `POST /drain` is 404
// and the two requests overlap, so `total` is 2 while both run.
//
// Assertions are on status codes, `/inflight` snapshots, SDK query counts and
// stop reasons, never on the model's wording. Costs a few cents of real tokens
// and needs a logged-in Claude subscription.
//
//   bun scripts/e2e-drain-live.mjs [--expect-baseline]
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const expectBaseline = process.argv.includes('--expect-baseline')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-drain-live-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
const apiKey = `drain-live-${randomUUID()}`
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_PASSTHROUGH: '1', MERIDIAN_API_KEY: apiKey })

let sdkQueries = 0
const realQuery = sdk.query
const observer = spyOn(sdk, 'query').mockImplementation(input => { sdkQueries += 1; return realQuery(input) })

const { startProxyServer } = await import('../src/proxy/server.ts')
const instance = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const address = instance.server.address()
assert(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const keyed = { 'content-type': 'application/json', 'x-api-key': apiKey }

const inflight = async () => (await fetch(`${base}/inflight`)).json()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await inflight()
    if (predicate(snapshot)) return snapshot
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(snapshot)}`)
    await sleep(100)
  }
}
// A streaming request; resolves with its status, stop reason and whether text arrived.
function generate(prompt, maxTokens) {
  const startedAt = Date.now()
  return fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...keyed, 'x-opencode-session': `drain-live-${randomUUID()}` },
    body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(240_000) }).then(async response => {
    const raw = await response.text()
    const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)) } catch { return {} } })
    return { status: response.status, stop: events.findLast(event => event.type === 'message_delta')?.delta?.stop_reason ?? null,
      text: events.some(event => event.delta?.type === 'text_delta'), errorFrame: events.some(event => event.type === 'error'),
      finishedAt: Date.now(), ms: Date.now() - startedAt }
  })
}

const report = { result: 'RUNNING', model, expectBaseline, platform: `${process.platform}/${process.arch}`, observed: {}, checks: [] }
const check = (ok, label, detail) => {
  report.checks.push({ ok: Boolean(ok), label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const completed = reply => reply.status === 200 && reply.stop === 'end_turn' && reply.text && !reply.errorFrame
const longPrompt = 'Write the integers from 1 to 400, one per line, with no other text.'
const shortPrompt = 'Reply with the single word READY.'

try {
  const first = generate(longPrompt, 4096)
  await until(snapshot => snapshot.total === 1 && sdkQueries === 1, 'the first request to be in flight with its SDK query started')
  const queriesBeforeSecond = sdkQueries

  const keyless = await fetch(`${base}/drain`, { method: 'POST' })
  const start = await fetch(`${base}/drain`, { method: 'POST', headers: keyed, body: JSON.stringify({ holdMs: 240_000 }) })
  const startBody = await start.json().catch(() => null)
  report.observed.drainStart = { keyless: keyless.status, keyed: start.status, body: startBody }

  const second = generate(shortPrompt, 64)
  console.log(`\n=== drain under overlapping live traffic (model=${model}, ${report.platform}, expectBaseline=${expectBaseline}) ===`)
  if (expectBaseline) {
    check(start.status === 404, 'build without the route: POST /drain is 404', `status=${start.status}`)
    const overlap = await until(snapshot => snapshot.total === 2, 'both requests to be in flight')
    check(overlap.total === 2, 'the second request runs beside the first, so total never has to reach 0', `total=${overlap.total}`)
    const [a, b] = await Promise.all([first, second])
    report.observed.first = a
    report.observed.second = b
    check(completed(a) && completed(b), 'both requests complete', JSON.stringify({ first: a, second: b }))
  } else {
    check(keyless.status === 401, 'a keyless POST /drain is refused', `status=${keyless.status}`)
    check(start.status === 200 && startBody?.started === true && startBody?.drain?.active === true, 'the keyed POST /drain starts a drain', JSON.stringify(startBody))
    const held = await until(snapshot => snapshot.drain?.held === 1, 'the second request to be held')
    report.observed.whileHeld = held
    check(held.total === 1 && held.draining === true, 'the second request is held outside total while the first runs', `total=${held.total} held=${held.drain.held}`)
    check(sdkQueries === queriesBeforeSecond, 'no SDK query has started for the held request', `queries=${sdkQueries}`)
    const a = await first
    report.observed.first = a
    check(completed(a), 'the first stream finishes untouched', JSON.stringify(a))
    const idle = await until(snapshot => snapshot.total === 0, 'total to reach 0')
    report.observed.idleWindow = idle
    check(idle.total === 0 && idle.drain.held === 1 && sdkQueries === queriesBeforeSecond,
      'total reaches 0 with the second request still held', `total=${idle.total} held=${idle.drain.held} queries=${sdkQueries}`)
    const keylessEnd = await fetch(`${base}/drain`, { method: 'DELETE' })
    const releasedAt = Date.now()
    const end = await fetch(`${base}/drain`, { method: 'DELETE', headers: keyed })
    const endBody = await end.json().catch(() => null)
    check(keylessEnd.status === 401 && end.status === 200 && endBody?.ended === true, 'only the keyed DELETE /drain ends the drain', `keyless=${keylessEnd.status} keyed=${end.status} ${JSON.stringify(endBody)}`)
    const b = await second
    report.observed.second = b
    check(completed(b) && b.finishedAt > releasedAt && sdkQueries === queriesBeforeSecond + 1,
      'the held request runs after release and completes', JSON.stringify({ ...b, queries: sdkQueries }))
    const after = await inflight()
    report.observed.after = after
    check(after.total === 0 && after.draining === false && after.drain.held === 0 && after.drain.admittedAtCap === 0,
      'nothing is left held or in flight', JSON.stringify(after.drain))
  }
  report.result = report.checks.every(row => row.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  report.result = 'FAIL'
  report.failure = String(error?.stack ?? error)
} finally {
  await instance.close()
  observer.mockRestore()
  console.log(JSON.stringify(report))
  process.exitCode = report.result === 'PASS' ? 0 : 1
}
