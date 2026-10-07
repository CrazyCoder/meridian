#!/usr/bin/env node
// Credential-free before/after probe: the upstream keeps running while the
// guarded consumer's event loop is frozen. Node: --experimental-strip-types.
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = resolve(process.env.E2E_IDLE_GUARD_MODULE ?? 'src/proxy/streamIdleGuard.ts')
const { guardUpstreamIdle } = await import(pathToFileURL(modulePath).href)
const expectBaseline = process.argv.includes('--expect-baseline')
const writer = `
const net = require('node:net');
const mode = process.argv[1];
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket);
  let count = 0;
  const timer = setInterval(() => {
    count++;
    if (count <= 3 || mode === 'active') socket.write(JSON.stringify({type:'progress',count})+'\\n');
    else if (mode === 'ping') socket.write(JSON.stringify({type:'stream_event',event:{type:'ping'}})+'\\n');
  }, 50);
  socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
  socket.on('error', error => { if (error.code !== 'ECONNRESET') process.exitCode = 1; });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(); });
`

async function runCase(mode, freeze) {
  const upstream = spawn(process.execPath, ['--eval', writer, mode], {stdio:['ignore','pipe','pipe']})
  let upstreamError = ''
  upstream.stderr.on('data', chunk => { upstreamError += chunk })
  const exited = once(upstream, 'exit')
  const output = createInterface({input:upstream.stdout})
  const first = await Promise.race([once(output, 'line'), exited.then(() => {throw new Error('Upstream exited before readiness')})])
  const upstreamPort = Number(first[0])
  assert(upstreamPort > 0, 'Independent upstream did not publish its port')
  let freezeCount = 0
  const blocker = net.createServer(socket => socket.once('data', () => {
    freezeCount++
    // Block only this consumer; the separately spawned writer keeps sending.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2700)
    socket.end()
  }))
  await new Promise(accept => blocker.listen(0, '127.0.0.1', accept))
  const socket = net.connect(upstreamPort, '127.0.0.1')
  const lines = createInterface({input:socket})
  async function* messages() { for await (const line of lines) yield JSON.parse(line) }
  const late = [], stalls = []
  let count = 0, errorName = null, trigger
  try {
    for await (const message of guardUpstreamIdle(messages(), 250, ms => stalls.push(ms), undefined, row => late.push(row))) {
      assert.equal(message.type, 'progress')
      count++
      if (count === 3 && freeze) {
        trigger = net.connect(blocker.address().port, '127.0.0.1')
        trigger.end('freeze')
      }
      if (count === 12) break
    }
  } catch (error) {
    if (error.name !== 'UpstreamIdleError') throw error
    errorName = error.name
  } finally {
    trigger?.destroy(); socket.destroy(); lines.close(); output.close()
    await new Promise(accept => blocker.close(accept))
    upstream.kill('SIGTERM')
    const force = setTimeout(() => upstream.kill('SIGKILL'), 5000)
    const [code] = await exited.finally(() => clearTimeout(force))
    assert.equal(code, 0, 'Independent upstream failed: ' + upstreamError)
  }
  const row = {mode,freeze,freezeCount,count,errorName,stalls,late}
  if (mode === 'active' && (!freeze || !expectBaseline)) {
    assert.equal(count, 12, 'Queued upstream progress was rejected after the consumer freeze')
    assert.equal(errorName, null)
    if (freeze) assert(late.some(event => event.resumed && event.lateMs > 2000))
  } else {
    assert.equal(errorName, 'UpstreamIdleError', 'The silent/ping-only stream or baseline must stall')
    assert.equal(stalls.length, 1)
    if (freeze) {
      assert(stalls[0] > 2250)
      if (!expectBaseline) assert(late.every(event => !event.resumed), 'Transport pings were reported as model progress')
    }
  }
  assert.equal(freezeCount, Number(freeze))
  console.log(JSON.stringify(row))
}
for (const [mode, freeze] of [['active',true],['silent',true],['ping',true],['silent',false],['active',false]]) await runCase(mode,freeze)
console.log(JSON.stringify({result:'PASS',runtime:process.versions.bun ? 'bun/'+process.versions.bun : 'node/'+process.versions.node,platform:process.platform+'/'+process.arch,expectBaseline,independentUpstream:true}))
