#!/usr/bin/env bun
// Actual OpenCode -> SDK/model with gate fsync held asynchronously.
// Requires an owned native credential directory and independently installed scrub.
// Logs only assertions; raw client output stays in the isolated private fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import * as filePromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'
const credentialDir = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const scrub = realpathSync(process.env.E2E_PLUGIN_PATH)
const client = process.env.E2E_OPENCODE_BIN ?? 'opencode'
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const sdkVersion = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')).version
const cliVersion = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-code/package.json', import.meta.url), 'utf8')).version
const version = spawnSync(client, ['--version'], { encoding: 'utf8' })
assert.equal(version.status, 0, 'Cannot determine actual client version')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-sdk-gate-client-')))
const project = join(root, 'project'), config = join(root, 'client-config')
for (const dir of [project, config, join(root, 'proxy-config'), join(root, 'plugins')]) mkdirSync(dir, {mode: 0o700})
const receipt = 'ACCOUNT-RECEIPT-' + randomUUID()
writeFileSync(join(project, 'receipt.txt'), receipt, {mode: 0o600})
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'proxy-config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: project, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_NO_UPDATE_CHECK: '1',
  ...(process.env.E2E_CLAUDE_BIN ? { MERIDIAN_CLAUDE_PATH: realpathSync(process.env.E2E_CLAUDE_BIN) } : {}),
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_PASSTHROUGH: '1' })
const queries = [], servedModels = new Set(), realQuery = sdk.query
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  queries.push({credentialDirectoryMatched:input.options?.env?.CLAUDE_CONFIG_DIR === credentialDir, resume:!!input.options?.resume})
  return observeSdkModels(realQuery(input), servedModels)
})
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({plugins:[{path:scrub,enabled:true}]}), {mode:0o600})
let proxy, probeUrl, heldPublications = 0, responsiveProbes = 0, pendingDiskWaits = 0, failedProbes = 0
const gateHandles = new WeakSet(), originalOpen = filePromises.open
const openObserver = spyOn(filePromises, 'open').mockImplementation(async (...args) => {
  const handle = await originalOpen(...args)
  if (String(args[0]).includes('/sdk-process-gates/') && String(args[0]).includes('.gate.tmp-')) gateHandles.add(handle)
  return handle
})
const probe = await originalOpen(join(root, 'prototype-probe'), 'w')
const handlePrototype = Object.getPrototypeOf(probe), originalSync = handlePrototype.sync
await probe.close()
handlePrototype.sync = async function () {
  if (gateHandles.has(this)) {
    heldPublications++; pendingDiskWaits++
    const started = performance.now()
    await new Promise(resolve => setTimeout(resolve, 200))
    // HTTP must have run during the disk wait, before the actual CLI launch.
    assert(performance.now() - started >= 190)
    pendingDiskWaits--
  }
  return originalSync.call(this)
}
const polling = setInterval(async () => {
  if (!probeUrl || !pendingDiskWaits) return
  try {
    const response = await fetch(probeUrl + '/livez', {signal: AbortSignal.timeout(1000)})
    if (response.status === 200 && (await response.text()).trim() === 'ok') { if (pendingDiskWaits) responsiveProbes++ }
  } catch (error) { failedProbes++ }
}, 10)
const { startProxyServer } = await import('../dist/server.js')
async function run(name, args, env) {
  const child = spawn(client, args, {cwd:project,env,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data', chunk => {stdout += chunk}); child.stderr.on('data', chunk => {stderr += chunk})
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000)
  const exit = await new Promise((accept,reject) => {child.once('error',reject);child.once('exit',accept)}).finally(()=>clearTimeout(timeout))
  writeFileSync(join(root,name+'.stdout'), stdout,{mode:0o600});writeFileSync(join(root,name+'.stderr'),stderr,{mode:0o600})
  const events = stdout.split('\n').filter(line=>line.startsWith('{')).flatMap(line=>{try{return[JSON.parse(line)]}catch(error){return[]}})
  return {exit,events,session:events.find(event=>typeof event.sessionID==='string')?.sessionID}
}
try {
  proxy = await startProxyServer({port:0,host:'127.0.0.1',silent:true,pluginConfigPath,pluginDir:join(root,'plugins'),
    profiles:[{id:'browser-created',claudeConfigDir:credentialDir}], defaultProfile:'browser-created'})
  if (!proxy.server.listening) await once(proxy.server,'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`; probeUrl = url
  const plugins = await (await fetch(url+'/plugins/list')).json()
  assert(plugins.plugins.some(plugin=>plugin.name==='opencode-scrub'&&plugin.status==='active'),'Scrub plugin inactive')
  writeFileSync(join(config,'opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',plugin:[resolve('dist/meridian')],
    model:`anthropic/${model}`,small_model:`anthropic/${model}`,share:'disabled',permission:'allow',
    provider:{anthropic:{options:{apiKey:'local-profile-gate',baseURL:url},models:{[model]:{name:model,limit:{context:200000,output:1024},
      reasoning:false,tool_call:true,modalities:{input:['text'],output:['text']}}}}}}),{mode:0o600})
  const env={...process.env,OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1'}
  for(const kind of ['CONFIG','DATA','CACHE','STATE']) env['XDG_'+kind+'_HOME']=join(root,kind.toLowerCase())
  for(const key of Object.keys(env)) if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete env[key]
  const first=await run('first',['run','--format','json',`Use read to read ${join(project,'receipt.txt')} and repeat its exact contents.`],env)
  const firstText=first.events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('')
  const continued=first.session?await run('continued',['run','--format','json','--session',first.session,'Without tools, repeat the exact account receipt from the previous turn.'],env):null
  const continuedText=continued?.events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('')??''
  const summary={result:'FAIL',heldPublications,responsiveProbes,failedProbes,platform:`${process.platform}/${process.arch}`,bun:Bun.version,opencode:version.stdout.trim(),sdk:sdkVersion,claudeCode:cliVersion,model,
    firstExit:first.exit,continuedExit:continued?.exit,firstHasSession:!!first.session,
    toolCalls:first.events.filter(event=>event.type==='tool_use').length,firstReceipt:firstText.includes(receipt),continuedReceipt:continuedText.includes(receipt),
    allQueriesUseNewAccount:queries.length>0&&queries.every(query=>query.credentialDirectoryMatched),servedModels:[...servedModels],realSdkQueries:queries.length,
    resumed:queries.some(query=>query.resume),scrub:plugins.plugins.find(plugin=>plugin.name==='opencode-scrub')?.version,privateArtifacts:root}
  writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600})
  assert(heldPublications >= 2 && responsiveProbes > 0, 'Actual SDK gate disk waits or concurrent HTTP probes missing')
  assert.equal(first.exit,0,`First client failed; private artifacts: ${root}`)
  assert.equal(continued?.exit,0,`Continuation failed; private artifacts: ${root}`)
  assert(summary.toolCalls>0&&summary.firstReceipt&&summary.continuedReceipt,'Actual tool receipt or continuation missing')
  assert(summary.allQueriesUseNewAccount&&summary.resumed,'The new account was not used for all real SDK queries and resume')
  assert(servedModels.size>0&&[...servedModels].every(value=>value===model||value.startsWith(model+'-')),'Upstream response did not confirm the implicated model')
  summary.result='PASS';writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary))
} finally {clearInterval(polling);await proxy?.close();observer.mockRestore();openObserver.mockRestore();handlePrototype.sync=originalSync}
