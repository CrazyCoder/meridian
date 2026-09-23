// Opt-in live Claude Max gate: node scripts/e2e-opus-55.mjs after npm run build.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
const root = await mkdtemp(join(tmpdir(), 'meridian-opus55-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_DEFAULT_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_WORKDIR: join(root, 'proxy'), MERIDIAN_TELEMETRY_PERSIST: '0' })
for (const dir of ['config', 'proxy', 'client', 'pi']) await mkdir(join(root, dir))
const { startProxyServer } = await import('../dist/server.js')
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
if (!proxy.server.listening) await once(proxy.server, 'listening')
const url = `http://127.0.0.1:${proxy.server.address().port}`
console.log(`Artifacts: ${root}`)
const version = command => {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return (result.stdout + result.stderr).trim()
}
const report = { platform: process.platform, node: process.version, cli: version(new URL('../node_modules/.bin/claude', import.meta.url).pathname), pi: version('pi'), sdk: JSON.parse(await readFile(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url))).version, passed: [] }
try {
  const list = await (await fetch(url + '/v1/models')).json()
  assert(list.data.some(m => m.id === 'claude-opus-5-5'))
  for (const model of ['claude-opus-5-5', 'opus']) {
    const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1024, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Reply exactly OPUS55_READY. Do not use tools.' }] }), signal: AbortSignal.timeout(180000) })
    const result = await response.json()
    await writeFile(join(root, model + '.json'), JSON.stringify(result, null, 2))
    assert.equal(response.status, 200, JSON.stringify(result))
    assert(JSON.stringify(result.content).includes('OPUS55_READY'), JSON.stringify(result))
    report.passed.push(`${model}: nonstream text with thinking disabled requested`)
  }
  const model = 'claude-opus-5-5'
  const receipt = `OPUS55_${crypto.randomUUID()}\n`
  await writeFile(join(root, 'client', 'receipt.txt'), receipt)
  await writeFile(join(root, 'pi', 'models.json'), JSON.stringify({ providers: { meridian: { baseUrl: url, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 4096, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }] } } }))
  const child = spawn('pi', ['--provider', 'meridian', '--model', model, '--thinking', 'medium', '--tools', 'read,write', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '-p', 'Read receipt.txt and write its exact contents to copied.txt using your tools. Then report the receipt.'], { cwd: join(root, 'client'), env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'pi'), PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
  const [code] = await once(child, 'exit'); clearTimeout(timer)
  await writeFile(join(root, 'pi.log'), output)
  assert.equal(code, 0, output)
  assert.equal(await readFile(join(root, 'client', 'copied.txt'), 'utf8'), receipt)
  assert(output.includes(receipt.trim()), output)
  report.passed.push('actual Pi streaming client read/write tool roundtrip, exact random receipt')
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await proxy.close()
}
