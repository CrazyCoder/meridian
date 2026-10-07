#!/usr/bin/env bun
// Real OpenCode and the released oh-my-openagent messages-transform hook.
// The wrapper exposes only that hook to isolate the reported recovery behavior.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const credentialDir = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const scrub = realpathSync(process.env.E2E_PLUGIN_PATH)
const openagent = realpathSync(process.env.E2E_OPENAGENT_ROOT)
const meridian = realpathSync(process.env.E2E_MERIDIAN_ROOT ?? resolve('.'))
const client = process.env.E2E_OPENCODE_BIN ?? 'opencode'
const model = process.env.E2E_MODEL ?? 'claude-sonnet-4-6'
const expectResume = process.env.E2E_EXPECT_RESUME !== '0'
const recovery = '[internal] Continue from the previous assistant state.'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-prefill-client-')))
const project = join(root, 'project'), config = join(root, 'client-config')
for (const dir of [project, config, join(root, 'plugins'), join(root, 'home'), join(root, 'lsp')]) mkdirSync(dir, {mode:0o700})
// Prevent this unrelated plugin startup maintenance from sweeping any process.
for (const name of ['lsp-proxy-sweep.stamp','lsp-daemon-sweep.stamp']) writeFileSync(join(root,'lsp',name),'fixture', {mode:0o600})
const receipt = 'PREFILL-RECEIPT-' + randomUUID()
writeFileSync(join(project,'first.txt'), 'NEXT: '+join(project,'second.txt'), {mode:0o600})
writeFileSync(join(project,'second.txt'), 'NEXT: '+join(project,'third.txt'), {mode:0o600})
writeFileSync(join(project,'third.txt'), receipt, {mode:0o600})
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
Object.assign(process.env, {MERIDIAN_CONFIG_DIR:join(root,'proxy-config'), MERIDIAN_SESSION_DIR:join(root,'sessions'),
  MERIDIAN_WORKDIR:project, MERIDIAN_TELEMETRY_PERSIST:'0', MERIDIAN_NO_UPDATE_CHECK:'1',
  MERIDIAN_CREDENTIALS_READONLY:'1', MERIDIAN_PASSTHROUGH:'1'})
const queryFacts = [], nativeModels = new Set(), realQuery = sdk.query
const observer = spyOn(sdk,'query').mockImplementation(input => {
  queryFacts.push({resume:!!input.options?.resume,credentialDirectoryMatched:input.options?.env?.CLAUDE_CONFIG_DIR===credentialDir})
  const query = realQuery(input)
  return new Proxy(query, {get(target,key) {
    if (key===Symbol.asyncIterator) return async function* () {
      for await (const message of query) {
        const id = message.type==='assistant' ? message.message?.model : undefined
        if (typeof id==='string') nativeModels.add(id)
        yield message
      }
    }
    const value=Reflect.get(target,key,target)
    return typeof value==='function' ? value.bind(target) : value
  }})
})
const wrapper = join(root,'recovery-plugin.mjs'), hookFactsPath = join(root,'hook-facts.json')
writeFileSync(wrapper, `import { omoPlugin } from ${JSON.stringify(pathToFileURL(join(openagent,'dist/index.js')).href)}
import { writeFileSync } from 'node:fs'
export const recoveryProbe = async ctx => {
  const hooks = await omoPlugin(ctx)
  const transform = hooks['experimental.chat.messages.transform']
  if (typeof transform !== 'function') throw new Error('Released recovery transform unavailable')
  const facts=[]
  return {'experimental.chat.messages.transform':async (input,output)=>{
    const before=output.messages.length
    await transform(input,output)
    const tail=output.messages.at(-1)
    facts.push({appended:output.messages.length>before,syntheticRecovery:tail?.parts?.some(p=>p.synthetic===true && p.text===${JSON.stringify(recovery)})===true})
    writeFileSync(${JSON.stringify(hookFactsPath)},JSON.stringify(facts),{mode:0o600})
  }}
}
`, {mode:0o600})
writeFileSync(join(config,'omo.json'),JSON.stringify({telemetry:false,disabled_mcps:['websearch','context7','grep'],
  experimental:{disable_live_parent_wake_routing:true}}), {mode:0o600})
const pluginConfigPath=join(root,'plugins.json')
writeFileSync(pluginConfigPath,JSON.stringify({plugins:[{path:scrub,enabled:true}]}),{mode:0o600})
const logs=[], wire=[]
const savedConsole={log:console.log,warn:console.warn,error:console.error,debug:console.debug}
for (const key of Object.keys(savedConsole)) console[key]=(...args)=>logs.push(args.map(String).join(' '))
let proxy, child, childClosed
try {
  const {startProxyServer}=await import(pathToFileURL(join(meridian,'dist/server.js')).href)
  proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:false,pluginConfigPath,pluginDir:join(root,'plugins'),
    profiles:[{id:'owned-prefill',claudeConfigDir:credentialDir}],defaultProfile:'owned-prefill'})
  if (!proxy.server.listening) await once(proxy.server,'listening')
  proxy.server.on('request',(request)=>{
    if (request.method!=='POST' || !request.url?.includes('/messages')) return
    let raw=''
    request.on('data',chunk=>{raw+=chunk})
    request.on('end',()=>{
      const body=JSON.parse(raw), messages=body.messages??[]
      const tail=messages.at(-1), blocks=Array.isArray(tail?.content)?tail.content:[]
      wire.push({messageCount:messages.length,agentMode:request.headers['x-opencode-agent-mode'],
        closesToolRound:blocks.some(b=>b.type==='tool_result'),recovery:blocks.some(b=>b.type==='text'&&b.text===recovery)})
    })
  })
  const url=`http://127.0.0.1:${proxy.server.address().port}`
  const plugins=await(await fetch(url+'/plugins/list')).json()
  assert(plugins.plugins.some(p=>p.name==='opencode-scrub'&&p.status==='active'),'Independent scrub inactive')
  writeFileSync(join(config,'opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',
    plugin:[join(meridian,'dist/meridian'),wrapper],model:`anthropic/${model}`,small_model:`anthropic/${model}`,
    share:'disabled',permission:'allow',provider:{anthropic:{options:{apiKey:'local-prefill-fixture',baseURL:url},
      models:{[model]:{name:model,limit:{context:200000,output:2048},reasoning:false,tool_call:true,
        modalities:{input:['text'],output:['text']}}}}}}),{mode:0o600})
  const env={...process.env,HOME:join(root,'home'),OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1',
    OMO_LSP_DAEMON_DIR:join(root,'lsp')}
  delete env.OMO_LSP_DAEMON_VERSION
  for(const kind of ['CONFIG','DATA','CACHE','STATE']) env['XDG_'+kind+'_HOME']=join(root,kind.toLowerCase())
  for(const key of Object.keys(env)) if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete env[key]
  child=spawn(client,['run','--format','json',`Use read to read ${join(project,'first.txt')}. Follow each NEXT path by reading it separately, one at a time. When a file contains a PREFILL-RECEIPT, report that exact receipt. Do not use other tools.`],
    {cwd:project,env,stdio:['ignore','pipe','pipe']})
  childClosed=new Promise(accept=>child.once('close',accept))
  let stdout='',stderr=''
  child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk})
  const timeout=setTimeout(()=>child.kill('SIGKILL'),180000)
  const exit=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept)}).finally(()=>clearTimeout(timeout))
  writeFileSync(join(root,'client.stdout'),stdout,{mode:0o600});writeFileSync(join(root,'client.stderr'),stderr,{mode:0o600})
  assert.equal(exit,0,`Real client failed; private fixture ${root}`)
  const events=stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  assert(events.filter(e=>e.type==='text').map(e=>e.part?.text??'').join('').includes(receipt),'Real client lost the tool receipt')
  const deadline=Date.now()+10000
  while(Date.now()<deadline) {
    if((await(await fetch(url+'/inflight')).json()).total===0) break
    await new Promise(accept=>setTimeout(accept,25))
  }
  assert.equal((await(await fetch(url+'/inflight')).json()).total,0,'Client request cleanup did not join')
  const hookFacts=JSON.parse(readFileSync(hookFactsPath,'utf8'))
  const recoveries=wire.filter(f=>f.closesToolRound&&f.recovery)
  const divergences=logs.filter(line=>line.includes('adapter=opencode')&&line.includes('diverged=modified-history'))
  savedConsole.log(JSON.stringify({phase:'observed',toolRecoveryRounds:recoveries.length,
    modifiedHistoryReplays:divergences.length,queryFacts,nativeModels:[...nativeModels],privateFixture:root}))
  assert(hookFacts.some(f=>f.appended&&f.syntheticRecovery),'Real released hook did not activate')
  assert(recoveries.length>=3,'Actual client did not send three recovery tool rounds')
  assert(queryFacts.every(f=>f.credentialDirectoryMatched),'SDK used a different account')
  assert(nativeModels.has(model),'Actual implicated model was not observed')
  if(expectResume) assert.equal(divergences.length,0,'Recovery text caused a replay')
  else assert(divergences.length>=1,'Unchanged baseline did not reproduce modified-history replay')
  savedConsole.log(JSON.stringify({pass:true,expectResume,client:spawnSync(client,['--version'],{encoding:'utf8'}).stdout.trim(),
    openagent:JSON.parse(readFileSync(join(openagent,'package.json'),'utf8')).version,model,nativeModels:[...nativeModels],
    toolRecoveryRounds:recoveries.length,modifiedHistoryReplays:divergences.length,nativeQueries:queryFacts.length,
    resumedQueries:queryFacts.filter(f=>f.resume).length,privateFixture:root}))
} finally {
  if(child&&child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL')
  if(childClosed) await childClosed
  if(proxy) await proxy.close()
  observer.mockRestore()
  writeFileSync(join(root,'proxy.log'),logs.join('\n'),{mode:0o600})
  for(const key of Object.keys(savedConsole)) console[key]=savedConsole[key]
}
