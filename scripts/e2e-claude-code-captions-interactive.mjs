#!/usr/bin/env bun
// Live: do a subagent's progress captions leave its working session alone,
// with the REAL interactive Claude Code client? (#1288, #1292)
//
// Interactive Claude Code asks for a 3-5 word caption of each running
// subagent about every 30 seconds. The caption request carries the subagent's
// agent id, streams, carries its tools, and appends the caption prompt to the
// last user message. Read as a turn, it replaced the subagent's session
// mapping, so the subagent's next real turn diverged (`modified-history`) and
// replayed from scratch. Print mode (`claude -p`) never sends captions, so
// this drives the interactive TUI in a PTY
// (e2e-claude-code-captions-interactive-driver.py) with two subagents kept
// busy long enough to be captioned.
//
// The client gets its own CLAUDE_CONFIG_DIR (onboarding pre-seeded) and a
// dummy bearer token; the proxy keeps its real Claude Max authentication. A
// recording relay ties each proxy log line to the agent id it carried.
//
// Pass: at least one side call was handled as an auxiliary request, the next
// request of each flow that already had a turn resumed (`lineage=continuation`),
// and no working request diverged. The interactive client's session-title
// request at startup and each subagent's first caption (sent while its first
// tool call is still running) are among the side calls.
// `--expect-baseline` is for a build without #1292: no caption is isolated and
// at least one subagent's next turn after a caption-sized request diverges.
// Costs real tokens (two subagents for about two minutes).
//
//   bun scripts/e2e-claude-code-captions-interactive.mjs [--expect-baseline]
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const say = console.log.bind(console)

const which = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' })
if (which.status !== 0 || !which.stdout.trim()) {
  say('SKIP: the `claude` CLI is not on PATH; this gate drives the real client')
  process.exit(1)
}
const CLI = which.stdout.trim()
const version = spawnSync(CLI, ['--version'], { encoding: 'utf8' }).stdout.trim()

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mccsub-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3562)
const MODEL = process.env.PROBE_MODEL ?? 'sonnet'
const MAX_WAIT_MS = 1000

const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const PROXY_PORT = PORT + 1
const inst = await startProxyServer({ port: PROXY_PORT, host: '127.0.0.1' })

const agentOf = new Map()
let relaySeq = 0
const relay = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 255,
  fetch(req) {
    const url = new URL(req.url)
    const headers = new Headers(req.headers)
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const id = `e77-${++relaySeq}`
      headers.set('x-request-id', id)
      agentOf.set(id, req.headers.get('x-claude-code-agent-id') ?? 'main')
    }
    url.port = String(PROXY_PORT)
    return fetch(url, {
      method: req.method,
      headers,
      body: req.body,
      duplex: 'half',
      timeout: false,
      decompress: false,
    })
  },
})

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// One record per proxy request line, tied to the agent id the relay saw.
const records = () => proxyLog
  .map(l => /^\[PROXY\] (\S+) (adapter=.*msgCount=.*)$/.exec(l))
  .filter(Boolean)
  .map(([, id, line]) => ({ id, agent: agentOf.get(id) ?? 'unknown', line }))
const isAux = r => r.line.includes('diverged=independent-request:auxiliary-request')
const toolCount = r => Number(/ tools=(\d+)/.exec(r.line)?.[1] ?? 0)
const waitMs = r => Number(/ sessionWait=(\d+)ms/.exec(r.line)?.[1] ?? 0)
const brief = r => `${r.agent === 'main' ? 'main' : `agent:${r.agent.slice(0, 8)}`} ${r.line
  .replace(/ sdkActive=\S+ sdkQueued=\S+/, '').replace(/ msgs=.*/, '')}`
const describe = r => `msgCount=${/msgCount=(\d+)/.exec(r.line)?.[1]} lineage=${/lineage=(\S+)/.exec(r.line)?.[1]}`
  + ` diverged=${/diverged=(\S+)/.exec(r.line)?.[1] ?? 'none'}`

function childEnv(configDir) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE|_)/.test(key)) delete env[key]
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: 'meridian-e2e-dummy',
  }
}

// Spawned asynchronously and drained concurrently: spawnSync deadlocks once
// the client fills a pipe while it waits on the proxy (see E55). Default
// permission mode with the probe's tools pre-allowed, so no auto-mode
// classifier runs and every request here is a main or subagent turn (E71
// covers the classifier).
async function runClient(cwd, configDir, args) {
  const proc = Bun.spawn([
    CLI, ...args, '--model', MODEL, '--permission-mode', 'default',
    '--allowedTools', 'Bash(echo:*)', 'Bash(sleep:*)', 'Agent',
  ], {
    cwd,
    env: childEnv(configDir),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 300000)
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { status, out: out.trim(), err: err.trim() }
}

async function turn(label, cwd, configDir, args) {
  const from = records().length
  const result = await runClient(cwd, configDir, args)
  const recs = records().slice(from)
  say(`\n  ${label} (${recs.length} proxy requests) exit=${result.status}: ${result.out.slice(0, 60)}`)
  for (const r of recs) say(`    ${brief(r)}`)
  return { ...result, recs }
}

const expectBaseline = process.argv.includes('--expect-baseline')
say(`\n=== Claude Code progress captions (interactive client) ===`)
say(`  client: ${version}   adapter: claude-code   model: ${MODEL}   expectBaseline=${expectBaseline}`)

const CONFIG = realpathSync(mkdtempSync(join(tmpdir(), 'mcccapconf-')))
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'mcccapproj-')))
writeFileSync(join(PROJECT, 'README.md'), 'scratch project\n')

const before = records().length
const driver = join(import.meta.dir, 'e2e-claude-code-captions-interactive-driver.py')
const drive = Bun.spawn(['python3', driver, CLI, PROJECT, CONFIG, `http://127.0.0.1:${PORT}`, MODEL, [
    'Use the Agent tool to launch two general-purpose subagents in parallel, in a single message,',
    'both in the foreground (run_in_background false).',
    'Subagent ALPHA must run `sleep 40` three times, each in its own separate Bash call, then `echo alpha-2`, then report.',
    'Subagent BETA must do the same, ending with `echo beta-2`.',
    'When both have reported, reply with exactly the word DONE.',
  ].join(' '), '600'], { stdout: 'pipe', stderr: 'pipe' })
const [driveOut, driveErr] = await Promise.all([new Response(drive.stdout).text(), new Response(drive.stderr).text(), drive.exited])
say(`\n  interactive driver: ${driveOut.trim()} ${driveErr.trim().slice(0, 300)}`)
const recs = records().slice(before)
for (const r of recs) say(`    ${brief(r)}`)
const aux = recs.filter(isAux)
const usageOf = id => proxyLog.map(l => new RegExp(`^\\[PROXY\\] ${id} usage: (.*)$`).exec(l)?.[1]).find(Boolean) ?? 'no usage line'
say(`\n  auxiliary requests: ${aux.length}`)
for (const r of aux) say(`    AUX ${brief(r)}\n        usage: ${usageOf(r.id)}`)
// The request after each caption, from the same subagent.
const nextAfter = r => recs.slice(recs.indexOf(r) + 1).find(n => n.agent === r.agent && !isAux(n))
const subagentTurns = recs.filter(r => r.agent !== 'main' && r.agent !== 'unknown')
if (expectBaseline) {
  check(aux.length === 0, 'build without #1292: no caption is handled as auxiliary', `${aux.length}`)
  check(subagentTurns.some(r => r.line.includes('diverged=modified-history')),
    'a subagent turn diverges after its caption replaced the mapping', subagentTurns.filter(r => r.line.includes('modified-history')).map(describe).join(' | '))
} else {
  check(aux.length > 0, 'captions were sent and handled as auxiliary requests', `${aux.length}`)
  // A side call sent before its flow's first working turn (the session title)
  // is followed by that first turn, which is new by definition.
  const hadTurnBefore = r => recs.slice(0, recs.indexOf(r)).some(p => p.agent === r.agent && !isAux(p))
  const after = aux.filter(hadTurnBefore).map(nextAfter).filter(Boolean)
  check(after.length > 0 && after.every(r => r.line.includes('lineage=continuation')),
    'the next turn after each side call resumed its session', after.map(describe).join(' | '))
  const diverged = recs.filter(r => !isAux(r) && /diverged=(unrelated-history|modified-history)/.test(r.line))
  check(diverged.length === 0, 'no working request diverged', diverged.map(describe).join(' | '))
}
relay.stop(true)
await inst.close?.()
say(failures.length ? `\n  FAIL: ${failures.length}` : '\n  PASS')
process.exit(failures.length ? 1 : 0)
