// Actual Pi + official agy: a replayed history past agy's ~192,000-byte input step must still deliver the newest turn.
// Run once against an unchanged server build (expected to lose the question) and once against the candidate.
// Usage: node scripts/e2e-antigravity-prompt-limit.mjs <dist/server.js> <pi cli.js> <official agy> <report.json> <label>
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'

const [serverPath, piPath, executable, reportPath, label] = process.argv.slice(2)
assert(label, 'Expected server, Pi CLI, official agy, report, label')
const model = 'gemini-3.8-flash-low', idleMs = 3000, files = 6, fileBytes = 40_000
process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|AZURE_OPENAI_|GOOGLE_API_KEY$|GEMINI_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_GENAI_USE_|GOOGLE_GEMINI_BASE_URL$)/.test(key)) delete process.env[key]
const localKey = randomUUID()
process.env.MERIDIAN_API_KEY = localKey
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Record what Meridian writes to each agy process: the size of every user input step.
const steps = [], originalSpawn = cp.spawn
cp.spawn = function (...args) {
  const child = originalSpawn.apply(this, args)
  if (args[0] === executable && args[1]?.includes?.('--input-format')) {
    const write = child.stdin.write.bind(child.stdin)
    child.stdin.write = (chunk, ...rest) => { try { steps.push(Buffer.byteLength(JSON.parse(String(chunk)).message.content)) } catch { steps.push(-1) } return write(chunk, ...rest) }
  }
  return child
}
syncBuiltinESMExports()
const { startProxyServer } = await import(pathToFileURL(serverPath).href)

const root = await mkdtemp(join(tmpdir(), 'meridian-agy-prompt-limit-'))
const project = join(root, 'project'), config = join(root, 'pi-config')
await mkdir(project, { recursive: true }); await mkdir(config, { recursive: true })
const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
const codes = []
for (let n = 1; n <= files; n++) {
  const head = `H${n}${randomUUID().slice(0, 6).toUpperCase()}`, tail = `T${n}${randomUUID().slice(0, 6).toUpperCase()}`
  codes.push({ head, tail })
  const lines = [`HEAD_CODE=${head}`]
  for (let i = 0; Buffer.byteLength(lines.join('\n')) < fileBytes; i++) lines.push(`${n}.${i} ` + Array.from({ length: 12 }, (_, j) => words[(i * 7 + j * 3 + n) % words.length]).join(' '))
  lines.push(`TAIL_CODE=${tail}`)
  await writeFile(join(project, `part${n}.txt`), lines.join('\n') + '\n')
}

const report = { label, result: 'INCOMPLETE', model, idleMs, files, fileBytes, platform: process.platform, arch: process.arch, node: process.version,
  agy: cp.execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), agyHash: createHash('sha256').update(await readFile(executable)).digest('hex'),
  pi: (({ stdout, stderr }) => `${stdout}${stderr}`.trim())(cp.spawnSync(process.execPath, [piPath, '--version'], { encoding: 'utf8' })), steps, health: [] }
let proxy, child, failure
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true, idleConversationMs: idleMs } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  const health = async name => { const h = await (await fetch(url + '/health')).json(); report.health.push({ name, processes: h.processes, reused: h.reused, completed: h.completed }); return h }
  await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: url, apiKey: localKey, api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  await writeFile(join(config, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }))
  child = originalSpawn(process.execPath, [piPath, '--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--mode', 'rpc', '--no-session', '--tools', 'read', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--system-prompt', 'You are a careful assistant. Use the read tool when asked to read files; otherwise answer from the conversation.'],
    { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []; let buffer = '', closed = false
  child.stdout.setEncoding('utf8'); child.stderr.resume()
  child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) events.push(JSON.parse(line)) } })
  child.once('close', () => { closed = true })
  const until = async (find, name) => { const end = Date.now() + 300_000; while (Date.now() < end) { const found = find(); if (found) return found; assert(!closed, `Pi closed during ${name}`); await delay(50) } throw new Error(`Pi deadline: ${name}`) }
  const command = async (type, fields = {}) => { const id = randomUUID(); child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n'); const reply = await until(() => events.find(e => e.type === 'response' && e.id === id), type); assert.equal(reply.success, true, JSON.stringify(reply)); return reply.data }
  const prompt = async message => { const start = events.length; await command('prompt', { message }); return until(() => events.slice(start).find(e => e.type === 'agent_end'), 'agent end').then(end => ({ end, events: events.slice(start) })) }
  const text = end => end.messages?.filter(m => m.role === 'assistant').flatMap(m => (m.content ?? []).filter(b => b.type === 'text').map(b => b.text)).join('\n') ?? ''
  await command('get_state'); await command('set_auto_retry', { enabled: false })

  const first = await prompt(`Use the read tool to read part1.txt, part2.txt, part3.txt, part4.txt, part5.txt and part6.txt in that order, one call per file, each file whole. After the last one, reply only DONE.`)
  report.reads = first.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'read').length
  assert.equal(report.reads, files, `Pi must read all ${files} files in turn 1`)
  await health('after turn 1')
  await delay(idleMs + 3000)
  const idle = await health('after idle expiry')
  assert.equal(idle.processes, 0, 'The finished conversation must be retired so the next turn replays the whole history')

  const nonce = `ZEBRA${randomUUID().slice(0, 6).toUpperCase()}`
  const before = steps.length
  const second = await prompt(`Without using any tools, answer from the files you already read. Reply on one line with: the TAIL_CODE at the very end of part6.txt, the HEAD_CODE at the very top of part1.txt, and then the word ${nonce}.`)
  await health('after turn 2')
  const answer = text(second.end)
  report.turn2 = { replayStepBytes: steps.slice(before), answer: answer.slice(0, 300), newestTail: answer.includes(codes[files - 1].tail), oldestHead: answer.includes(codes[0].head), nonce: answer.includes(nonce),
    toolCalls: second.events.filter(e => e.type === 'tool_execution_start').length, errored: !!second.end.messages?.some(m => m.stopReason === 'error') }
  report.result = report.turn2.newestTail && report.turn2.nonce ? 'NEWEST_TURN_DELIVERED' : 'NEWEST_TURN_LOST'
} catch (error) { failure = error; report.error = String(error?.stack ?? error).slice(0, 1500) }
finally {
  if (child && !child.killed) child.kill('SIGTERM')
  await proxy?.close?.()
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
if (failure || report.result !== 'NEWEST_TURN_DELIVERED') process.exitCode = 1
