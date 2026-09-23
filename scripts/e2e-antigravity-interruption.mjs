// Real official-CLI fault gate: fail a read-only probe, then crash during generation.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

assert.notEqual(process.platform, 'win32', 'This process-death gate requires POSIX process groups')
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-interruption-'))
console.log(`Artifacts: ${root}`)
const official = process.env.MERIDIAN_AGY_PATH || 'agy'
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const version = spawnSync(official, ['--version'], { encoding: 'utf8' })
assert.equal(version.status, 0, version.stderr)
const report = { cli: version.stdout.trim(), node: process.version, platform: process.platform, model, passed: [] }
const mark = message => { report.passed.push(message); console.log('PASS', message) }
const audit = join(root, 'calls.jsonl'), fail = join(root, 'fail-config'), executable = join(root, 'agy.cjs')
await writeFile(audit, '')
await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'), {spawn}=require('node:child_process');
const args=process.argv.slice(2);
const audit=value=>fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({pid:process.pid,args,...value})+'\\n');
audit({event:'start'});process.on('exit',()=>audit({event:'exit'}));
if(args[1]==='/config'&&fs.existsSync(${JSON.stringify(fail)})) process.exit(23);
const child=spawn(${JSON.stringify(official)},args,{stdio:'inherit'});
child.once('error',()=>{process.exitCode=1});child.once('exit',code=>{process.exitCode=code??1});
`, { mode: 0o755 })
const host = join(root, 'host.mjs')
await writeFile(host, `
import {startProxyServer} from ${JSON.stringify(new URL('../dist/server.js', import.meta.url).href)};
import {once} from 'node:events';
const proxy=await startProxyServer({backend:'antigravity',port:0,silent:true,antigravity:{executable:${JSON.stringify(executable)},statePath:${JSON.stringify(join(root, 'state.sqlite'))},plugins:[{name:'shutdown-observer',onTelemetry:async()=>{process.send({telemetry:true});await new Promise(resolve=>setTimeout(resolve,500))}}]}});
if(!proxy.server.listening) await once(proxy.server,'listening');
process.send({url:'http://127.0.0.1:'+proxy.server.address().port});
process.on('message',async message=>{if(message==='close'){await proxy.close();process.exit(0)}});
`)
let child, output = ''
const calls = async () => (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
async function start() {
  child = spawn(process.execPath, [host], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true })
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service start timed out: ' + output)), 90000)
    child.once('message', value => { clearTimeout(timer); resolve(value.url) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Service exited: ' + code + output)) })
  })
}
async function stop(crash = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (crash) process.kill(-child.pid, 'SIGKILL')
  else child.send('close')
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL') }, 10000)
  try { await exited } finally { clearTimeout(timer) }
}
const killed = new Set()
async function killOwnedCli() {
  const records = await calls()
  const finished = new Set(records.filter(call => call.event === 'exit').map(call => call.pid))
  for (const call of records) {
    if (finished.has(call.pid) || killed.has(call.pid)) continue
    killed.add(call.pid)
    try { process.kill(-call.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
const body = { model, messages: [{ role: 'user', content: 'Write every integer from 1 through 10000, one per line, with no omissions or commentary.' }], stream: true }
try {
  let url = await start()
  await writeFile(fail, '1')
  const failed = await fetch(url + '/readyz', { signal: AbortSignal.timeout(70000) })
  assert.equal(failed.status, 503)
  assert((await failed.text()).includes('reason=exit'))
  const count = (await calls()).length
  await unlink(fail)
  const cooled = await fetch(url + '/readyz')
  assert.equal(cooled.status, 503)
  assert(Number(cooled.headers.get('retry-after')) > 0)
  assert((await cooled.text()).includes('cooling down'))
  assert.equal((await calls()).length, count)
  await new Promise(resolve => setTimeout(resolve, 5100))
  const ready = await fetch(url + '/readyz', { signal: AbortSignal.timeout(70000) })
  assert.equal(ready.status, 200, await ready.text())
  mark('read-only failure cooldown prevents new probes; fresh official validation recovers')
  const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'crash-test' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  let prefix = ''
  while (!prefix.includes('text_delta')) {
    const next = await reader.read(); assert(!next.done, prefix)
    prefix += Buffer.from(next.value).toString()
    assert(!prefix.includes('event: error'), prefix)
  }
  assert(!prefix.includes('message_stop'), 'Need an unfinished generation for this fault')
  await writeFile(join(root, 'visible-prefix.sse'), prefix)
  await stop(true)
  await killOwnedCli()
  await reader.cancel().catch(error => { output += '\nExpected broken stream: ' + error })
  url = await start()
  const beforeRetry = (await calls()).length
  const retry = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'crash-test' }, body: JSON.stringify(body) })
  const rejection = await retry.text()
  assert.equal(retry.status, 409, rejection)
  assert(rejection.includes('outcome is uncertain'), rejection)
  assert.equal((await calls()).length, beforeRetry, 'Uncertain replay must not spawn even a CLI probe')
  mark('real CLI generation interrupted by process death; durable guard rejects blind replay before dispatch')
  const nextBody = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply exactly RECOVERED' }] })
  const options = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'reviewed-new-turn' }, body: nextBody }
  const observing = once(child, 'message', { signal: AbortSignal.timeout(180000) })
  const pending = fetch(url + '/v1/messages', { ...options, signal: AbortSignal.timeout(180000) }).then(response => ({ response }), error => ({ error }))
  const [event] = await observing
  assert.equal(event.telemetry, true)
  const closing = stop()
  const outcome = await pending
  assert(outcome.response, String(outcome.error))
  const result = await outcome.response.json()
  assert.equal(outcome.response.status, 200, JSON.stringify(result))
  assert.equal(result.content.map(block => block.text || '').join('').trim(), 'RECOVERED')
  await closing
  mark('explicit new turn completes while graceful shutdown joins its telemetry cleanup')
  url = await start()
  const probeCount = (await calls()).length
  const saved = await fetch(url + '/v1/messages', options)
  assert.equal(saved.status, 200)
  assert.equal(saved.headers.get('x-meridian-response-replayed'), 'true')
  assert.deepEqual(await saved.json(), result)
  assert.equal((await calls()).length, probeCount)
  mark('joined shutdown retains the completed answer for cache-only generation-free recovery')
} catch (error) { report.error = String(error); throw error }
finally {
  await stop()
  await killOwnedCli()
  await writeFile(join(root, 'service.log'), output)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
}
