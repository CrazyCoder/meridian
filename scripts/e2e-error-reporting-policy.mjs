#!/usr/bin/env bun
// Real child processes, actual process handlers, local Sentry envelope collector.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'meridian-reporter-policy-'))
symlinkSync(realpathSync(join(repo, 'node_modules')), join(root, 'node_modules'))
const build = await Bun.build({ entrypoints: [join(repo, 'src/__tests__/fixtures/error-reporter-child.ts')], target: 'node', packages: 'external', outdir: root })
assert(build.success, build.logs.map(String).join('\n'))
const childFile = build.outputs[0].path
const events = []
const collector = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  events.push({ path: req.url, body }); res.end('{}')
})
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))
const dsn = `http://fixture@127.0.0.1:${collector.address().port}/42`
async function run({runtime, policy, enabled, recover, viaEnv}) {
  const dir = join(root, String(Math.random()).slice(2)); mkdirSync(dir)
  const before = events.length
  const env = { PATH: process.env.PATH, MERIDIAN_CONFIG_DIR: dir, REPORTER_SPOOL: join(dir, 'spool'),
    REPORTER_FAIL: 'reject', REPORTER_LINGER_MS: '100', REPORTER_NATURAL_EXIT: '1', REPORTER_NAME: 'Bearer synthetic-name-secret',
    ...(enabled ? { REPORTER_DSN: dsn } : {}), ...(recover ? { REPORTER_RECOVER: '1' } : {}),
    ...(viaEnv ? { NODE_OPTIONS: `--unhandled-rejections="${policy}"` } : {}) }
  const args = runtime === 'node' && !viaEnv ? [`--unhandled-rejections=${policy}`, childFile] : [childFile]
  const child = spawn(runtime === 'node' ? 'node' : process.execPath, args, {env, stdio: ['ignore', 'ignore', 'pipe']})
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timeout)
  if (enabled) for(let i=0;i<100 && events.length===before;i++) await new Promise(r=>setTimeout(r,25))
  const delivered = events.slice(before)
  if (enabled) {
    assert.equal(delivered.length, 1, `${runtime}/${policy}: expected exactly one event, got ${delivered.length}`)
    assert.equal(delivered[0].path, '/api/42/envelope/')
    for (const secret of ['synthetic-name-secret', 'bearermarkerbearermarker', 'OATMARKER', 'QUERYMARKER', 'REFRESHMARKER', 'hunter2']) assert(!delivered[0].body.includes(secret), `Leaked ${secret}`)
  } else assert.equal(delivered.length, 0)
  return {runtime, policy, recover, viaEnv, enabled, exit, survived: stderr.includes('Reporter probe survived'), recovered: stderr.includes('Uncaught exception (recovered)'), delivered: delivered.length}
}
async function runCli(runtime, enabled) {
  const dir = join(root, 'cli-' + runtime + '-' + enabled); mkdirSync(dir)
  const before = events.length
  const child = spawn(runtime === 'node' ? 'node' : process.execPath,
    [join(repo, 'dist/cli.js'), 'test-error-report'], {
      env: { PATH: process.env.PATH, MERIDIAN_CONFIG_DIR: dir,
        ...(enabled ? { MERIDIAN_ERROR_REPORTING_DSN: dsn } : {}) },
      stdio: ['ignore', 'ignore', 'ignore'] })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timeout)
  assert.equal(exit, 1)
  if (enabled) for(let i=0;i<100 && events.length===before;i++) await new Promise(r=>setTimeout(r,25))
  assert.equal(events.length-before, enabled ? 1 : 0)
  if (enabled) assert(events[before].body.includes('Meridian error-reporting test'))
  return {runtime, enabled, exit, delivered: events.length-before}
}
try {
  const results = []
  for (const runtime of ['node', 'bun']) for (const policy of runtime === 'node' ? ['throw','strict','warn','none','warn-with-error-code'] : ['throw']) {
    for (const recover of [false,true]) for (const viaEnv of runtime === 'node' ? [false,true] : [false]) {
      const baseline = await run({runtime,policy,enabled:false,recover,viaEnv})
      const final = await run({runtime,policy,enabled:true,recover,viaEnv})
      assert.equal(final.exit, baseline.exit, JSON.stringify({baseline,final}))
      assert.equal(final.survived, baseline.survived, JSON.stringify({baseline,final}))
      assert.equal(final.recovered, baseline.recovered, JSON.stringify({baseline,final}))
      results.push(final)
    }
  }
  const cli = []
  for (const runtime of ['node', 'bun']) for (const enabled of [false, true]) cli.push(await runCli(runtime, enabled))
  console.log(JSON.stringify({cli, result:'PASS',platform:`${process.platform}/${process.arch}`,node:'Node on PATH',bun:Bun.version,cases:results.length,results}))
} finally { await new Promise(resolve => collector.close(resolve)) }
