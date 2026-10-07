#!/usr/bin/env bun
// Actual OpenCode + unmodified opencode-with-claude 1.10.1. The wrapper only
// observes the real SDK and startup health; it does not replace SDK responses.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync,symlinkSync,readdirSync,readlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'
const client=realpathSync(process.env.E2E_OPENCODE_BIN)
const plugin=realpathSync(process.env.E2E_CLIENT_PLUGIN)
const sdk=realpathSync(process.env.E2E_SDK_MODULE)
const credentials=realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const latest=realpathSync(process.env.E2E_NEW_CLAUDE)
const older=realpathSync(process.env.E2E_OLD_CLAUDE)
assert.equal(JSON.parse(readFileSync(join(dirname(plugin),'..','package.json'),'utf8')).version,'1.10.1')
assert.equal(JSON.parse(readFileSync(join(dirname(sdk),'package.json'),'utf8')).version,'0.2.141')
const expectFailure=process.env.E2E_EXPECT_VERSION_FAILURE==='1'
const expectedSource=process.env.E2E_EXPECT_SOURCE??'path-lookup'
const model=process.env.E2E_MODEL??'claude-opus-5-5'
const override=process.env.E2E_USE_OVERRIDE==='1'
const noPath=process.env.E2E_NO_CLAUDE_ON_PATH==='1'
const brokenPath=process.env.E2E_BROKEN_CLAUDE_ON_PATH==='1'
const managedShims=process.env.E2E_MISE_SHIM_DIR?realpathSync(process.env.E2E_MISE_SHIM_DIR):undefined
const expectedVersion=process.env.E2E_EXPECT_CLAUDE_VERSION??(expectFailure?'2.1.268':'2.1.288')
assert.equal(spawnSync(client,['--version'],{encoding:'utf8'}).stdout.trim(),'1.18.34')
assert.equal(spawnSync(latest,['--version'],{encoding:'utf8'}).stdout.trim(),'2.1.288 (Claude Code)')
assert.equal(spawnSync(older,['--version'],{encoding:'utf8'}).stdout.trim(),'2.1.268 (Claude Code)')
const root=realpathSync(mkdtempSync(join(tmpdir(),'meridian-path-client-')))
for(const dir of ['project','home','config','shims','proxy','sessions'])mkdirSync(join(root,dir),{mode:0o700})
assert.equal(process.platform,'linux','This reported-platform probe verifies owned processes through Linux procfs')
const factsPath=join(root,'query-facts.json'),healthPath=join(root,'health-proof.json')
const receipt='PATH-RECEIPT-'+randomUUID()
if(brokenPath){writeFileSync(join(root,'shims','claude'),'#!/bin/sh\necho native binary not installed >&2\nexit 1\n',{mode:0o700})}
else if(!noPath && !managedShims)symlinkSync(latest,join(root,'shims','claude'))
const wrapper=join(root,'probe-plugin.mjs')
writeFileSync(wrapper,`import {ClaudeMaxPlugin} from ${JSON.stringify(pathToFileURL(plugin).href)}
import * as sdk from ${JSON.stringify(pathToFileURL(sdk).href)}
import {spyOn} from 'bun:test'
import {writeFileSync,renameSync} from 'node:fs'
const facts=[],actualQuery=sdk.query
spyOn(sdk,'query').mockImplementation(input=>{
  const fact={requestedModel:input.options?.model,executable:input.options?.pathToClaudeCodeExecutable,credentialMatched:input.options?.env?.CLAUDE_CONFIG_DIR===${JSON.stringify(credentials)},models:[],versionRejected:false,completed:false}
  facts.push(fact)
  const save=()=>{writeFileSync(${JSON.stringify(factsPath)}+'.tmp',JSON.stringify(facts),{mode:0o600});renameSync(${JSON.stringify(factsPath)}+'.tmp',${JSON.stringify(factsPath)})}
  save()
  const query=actualQuery(input)
  return new Proxy(query,{get(target,key){
    if(key===Symbol.asyncIterator)return async function*(){try{for await(const message of query){
      if(message.type==='assistant' && typeof message.message?.model==='string' && !fact.models.includes(message.message.model))fact.models.push(message.message.model)
      fact.versionRejected ||= JSON.stringify(message).includes('Claude Code 2.1.268 does not support this model')
      save();yield message
    }}finally{fact.completed=true;save()}}
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
})
export const pathProbe=async ctx=>{
  const hooks=await ClaudeMaxPlugin(ctx)
  return {...hooks,config:async config=>{
    await hooks.config?.(config)
    const health=await(await fetch(config.provider.anthropic.options.baseURL+'/health')).json()
    writeFileSync(${JSON.stringify(healthPath)},JSON.stringify({claudeExecutable:health.claudeExecutable}),{mode:0o600})
  }}
}
`,{mode:0o600})
writeFileSync(join(root,'config','opencode.json'),JSON.stringify({plugin:[wrapper],model:'anthropic/'+model,small_model:'anthropic/'+model,
  share:'disabled',permission:'allow',provider:{anthropic:{options:{apiKey:'owned-loopback'},models:{[model]:{name:model,
    limit:{context:200000,output:2048},reasoning:false,tool_call:true,modalities:{input:['text'],output:['text']}}}}}}),{mode:0o600})
const env={...process.env}
for(const key of Object.keys(env))if(/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_|OPENCODE_)/.test(key))delete env[key]
Object.assign(env,{HOME:join(root,'home'),OPENCODE_CONFIG_DIR:join(root,'config'),OPENCODE_DISABLE_AUTOUPDATE:'1',
  PATH:(noPath||brokenPath?join(root,'shims'):managedShims??join(root,'shims'))+':/usr/local/bin:/usr/bin:/bin',MERIDIAN_CONFIG_DIR:join(root,'proxy'),MERIDIAN_SESSION_DIR:join(root,'sessions'),
  MERIDIAN_WORKDIR:join(root,'project'),MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_CREDENTIALS_READONLY:'1',
  MERIDIAN_PROFILES:JSON.stringify([{id:'owned-path',claudeConfigDir:credentials}]),MERIDIAN_DEFAULT_PROFILE:'owned-path',CLAUDE_PROXY_PORT:'0'})
if(override)env.MERIDIAN_CLAUDE_PATH=older
for(const kind of ['CONFIG','DATA','CACHE','STATE'])env['XDG_'+kind+'_HOME']=join(root,kind.toLowerCase())
const child=spawn(client,['run','--format','json','--title','owned-executable-test','--model','anthropic/'+model,
  "For this JavaScript integration fixture, what exact text does console.log emit? const receipt = '"+receipt+"'; console.log(receipt). Reply with only the output line. Do not use tools."],{cwd:join(root,'project'),env,detached:true,stdio:['ignore','pipe','pipe']})
const closed=new Promise(resolve=>child.once('close',resolve))
let stdout='',stderr='',launchError
child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk})
child.once('error',error=>{launchError=error})
function ownedProcesses(){
  const found=[]
  for(const entry of readdirSync('/proc')){
    if(!/^\d+$/.test(entry))continue
    try{if(readlinkSync('/proc/'+entry+'/cwd')===join(root,'project')){
      const stat=readFileSync('/proc/'+entry+'/stat','utf8').split(') ')[1].split(' ')
      found.push({pid:Number(entry),start:stat[19]})
    }}catch(error){if(!['ENOENT','EACCES','ESRCH'].includes(error.code))throw error}
  }
  return found
}
try{
  const deadline=Date.now()+180000
  while(child.exitCode===null && child.signalCode===null && Date.now()<deadline){
    if(launchError)throw launchError
    assert(stdout.length+stderr.length<2*1024*1024,'Client output exceeded fixture bound')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.notEqual(child.exitCode,null,'Actual client did not finish; private fixture '+root)
  await closed
  const health=JSON.parse(readFileSync(healthPath,'utf8')),facts=JSON.parse(readFileSync(factsPath,'utf8'))
  const events=stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
  const delivered=events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('').includes(receipt)
  const rejected=facts.some(fact=>fact.versionRejected) && events.some(event=>event.type==='error' && JSON.stringify(event.error).includes('Claude Code 2.1.268 does not support this model'))
  assert.equal(health.claudeExecutable?.source,expectedSource)
  const selected=health.claudeExecutable.path
  assert(facts.length>0 && facts.every(fact=>fact.executable===selected),'Startup/health and SDK selected different executables')
  assert(facts.every(fact=>fact.credentialMatched),'SDK used another account')
  assert(facts.every(fact=>fact.completed),'An observed SDK iterator did not complete')
  const selectedVersion=spawnSync(selected,['--version'],{encoding:'utf8',env}).stdout.trim()
  assert.equal(selectedVersion,expectedVersion+' (Claude Code)')
  if(expectFailure){assert(!delivered);assert(rejected);assert([0,1].includes(child.exitCode))}
  else {assert.equal(child.exitCode,0);assert(delivered,'Actual client lost the receipt');assert(facts.some(fact=>fact.models.includes(model)),'Native served model did not match')}
  const cleanupDeadline=Date.now()+10000
  while(ownedProcesses().length && Date.now()<cleanupDeadline)await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal(ownedProcesses().length,0,'An owned client/SDK process survived frontend exit')
  const summary={result:'PASS',root,client:'1.18.34',plugin:'1.10.1',platform:process.platform,arch:process.arch,model,
    expectedSource,selectedVersion,expectFailure,delivered,versionRejected:rejected,queryCount:facts.length,
    nativeModels:[...new Set(facts.flatMap(fact=>fact.models))],frontendExit:child.exitCode,
    accountMatched:true,executableConsistent:true,completedSdkIterators:true,ownedResidualProcesses:0,
    joinedCleanup:true,override,noPath,brokenPath,miseManaged:!!managedShims && !brokenPath && !noPath}
  writeFileSync(join(root,'proof.json'),JSON.stringify(summary,null,2),{mode:0o600})
  console.log(JSON.stringify(summary))
}finally{
  writeFileSync(join(root,'client.stdout'),stdout,{mode:0o600});writeFileSync(join(root,'client.stderr'),stderr,{mode:0o600})
  if(child.exitCode===null && child.signalCode===null){
    process.kill(-child.pid,'SIGTERM')
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}},5000)
    await closed;clearTimeout(timer)
  }else await closed
  for(const fact of ownedProcesses()){
    // Refuse PID reuse: only stop a process with the same kernel start identity
    // still running in this harness's unique disposable working directory.
    if(ownedProcesses().some(current=>current.pid===fact.pid && current.start===fact.start)){
      try{process.kill(fact.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
    }
  }
}
