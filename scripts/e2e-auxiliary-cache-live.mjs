#!/usr/bin/env bun
// Live: do consecutive auxiliary replays reuse their cached history? (#1297)
//
// Claude Code asks for a progress caption of a running subagent every few
// seconds. Each caption is an auxiliary request (#1292), so Meridian replays
// the subagent's history fresh. Before #1297 that replay was one text block
// with no cache breakpoint inside it, so every caption wrote its whole history
// to the prompt cache again. With #1297 the replay carries a breakpoint at the
// end of the history, so the next caption reads the shared prefix instead.
//
// This sends three caption-shaped requests, exactly as the CLI shapes them
// (agent id header, streaming, the client's tools, the caption prompt appended
// to the last user message), over one subagent history that grows by one tool
// round between captions. It records `cache_creation_input_tokens` and
// `cache_read_input_tokens` for each from the real model. The history opens
// with a fresh nonce so no earlier run's cache can be hit.
//
// With the fix, captions 2 and 3 must read most of the history from the cache
// and write well under half of what caption 1 wrote. `--expect-baseline`
// asserts the opposite, for a build without the fix. Every caption must be
// handled as an auxiliary request on either build. Costs a few cents of real
// tokens and needs a logged-in Claude subscription.
//
//   bun scripts/e2e-auxiliary-cache-live.mjs [--expect-baseline]
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const expectBaseline = process.argv.includes('--expect-baseline')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-aux-cache-live-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: '0' })

const proxyLog = []
for (const key of ['log', 'error', 'warn']) {
  const original = console[key].bind(console)
  console[key] = (...args) => { const line = args.map(String).join(' '); if (line.startsWith('[PROXY]')) proxyLog.push(line); else original(...args) }
}
const { startProxyServer } = await import('../src/proxy/server.ts')
const instance = await startProxyServer({ port: 0, host: '127.0.0.1' })
const address = instance.server.address()
assert(address && typeof address === 'object')
const base = `http://127.0.0.1:${address.port}`
const model = process.env.E2E_MODEL ?? 'claude-sonnet-5-5'
const nonce = randomUUID()

const CAPTION = `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
PREVIOUS
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
const captionPrompt = previous => CAPTION.replace('PREVIOUS\n', previous ? `\nPrevious: "${previous}" — say something NEW.\n\n` : '\n')

// A deterministic source file of roughly 1,500 tokens per tool round.
const source = index => Array.from({ length: 60 }, (_, line) =>
  `export function step${index}_${line}(input: number): number { return input * ${line + 1} + ${index} } // module ${index} line ${line}`).join('\n')
const rounds = count => Array.from({ length: count }, (_, index) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `read-${index}`, name: 'Read', input: { file_path: `src/module${index}.ts` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${index}`, content: source(index) }] },
]).flat()
const tools = [{ name: 'Read', description: 'Read a file from the working directory.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
const sessionId = randomUUID()
const agentId = `a${randomUUID().replaceAll('-', '').slice(0, 16)}`

function captionMessages(roundCount, previous) {
  const history = [{ role: 'user', content: `Task ${nonce}: read each module under src/ in order and summarize what it exports.` }, ...rounds(roundCount)]
  const last = history.at(-1)
  return [...history.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text: captionPrompt(previous) }] }]
}

async function caption(roundCount, previous) {
  const before = proxyLog.length
  const response = await fetch(`${base}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.299 (external, cli)', 'x-claude-code-agent-id': agentId,
      'x-claude-code-session-id': sessionId },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, tools, metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: captionMessages(roundCount, previous) }),
    signal: AbortSignal.timeout(180_000) })
  const raw = await response.text()
  const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)) } catch { return {} } })
  const usage = { ...events.find(event => event.type === 'message_start')?.message?.usage, ...events.findLast(event => event.type === 'message_delta')?.usage }
  const text = events.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join('').trim()
  const lines = proxyLog.slice(before)
  return { status: response.status, text, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0,
    input: usage.input_tokens ?? 0, auxiliary: lines.some(line => line.includes('diverged=independent-request:auxiliary-request')) }
}

const report = { result: 'RUNNING', model, expectBaseline, platform: `${process.platform}/${process.arch}`, captions: [], checks: [] }
const check = (ok, label, detail) => {
  report.checks.push({ ok: Boolean(ok), label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
try {
  let previous
  for (const roundCount of [4, 5, 6]) {
    const row = await caption(roundCount, previous)
    report.captions.push({ rounds: roundCount, ...row })
    previous = row.text || previous
  }
  console.log(`\n=== consecutive auxiliary replays (model=${model}, ${report.platform}, expectBaseline=${expectBaseline}) ===`)
  for (const row of report.captions) console.log(`  rounds=${row.rounds} status=${row.status} auxiliary=${row.auxiliary} cache_write=${row.cacheWrite} cache_read=${row.cacheRead} input=${row.input} "${row.text}"`)
  const [first, ...later] = report.captions
  check(report.captions.every(row => row.status === 200 && row.text.length > 0), 'every caption answered', JSON.stringify(report.captions.map(row => row.status)))
  check(report.captions.every(row => row.auxiliary), 'every caption was handled as an auxiliary request')
  check(first.cacheWrite > 4000, 'the first caption wrote its history to the cache', `${first.cacheWrite}`)
  const reused = later.every(row => row.cacheRead >= first.cacheWrite * 0.8 && row.cacheWrite < first.cacheWrite * 0.5)
  check(expectBaseline ? !reused : reused,
    expectBaseline ? 'without the fix, later captions rewrite their history (unfixed build)' : 'later captions read the shared history and write well under half of the first',
    JSON.stringify(later.map(row => ({ write: row.cacheWrite, read: row.cacheRead }))))
  report.result = report.checks.every(row => row.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  report.result = 'FAIL'
  report.failure = String(error?.stack ?? error)
} finally {
  await instance.close()
  console.log(JSON.stringify(report))
  process.exitCode = report.result === 'PASS' ? 0 : 1
}
