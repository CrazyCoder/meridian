#!/usr/bin/env bun
// Actual OpenCode/SDK/model request activity, two isolated headless clients.
// E2E_AUTH_FILE is a private read-only {accessToken,expiresAt} snapshot with no
// refresh token. E2E_PLUGIN_PATH selects an independently installed scrub.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'
const auth = JSON.parse(readFileSync(process.env.E2E_AUTH_FILE,'utf8'))
assert(typeof auth.accessToken==='string'&&auth.accessToken.length>0&&auth.expiresAt>Date.now(),'Missing current private access snapshot')
assert(!('refreshToken' in auth),'Use an access-only snapshot')
const scrub=realpathSync(process.env.E2E_PLUGIN_PATH),client=process.env.E2E_OPENCODE_BIN??'opencode',model=process.env.E2E_MODEL??'claude-opus-5-5'
const version=spawnSync(client,['--version'],{encoding:'utf8'});assert.equal(version.status,0)
const root=realpathSync(mkdtempSync(join(tmpdir(),'meridian-inflight-client-')))
for(const dir of ['proxy','plugins'])mkdirSync(join(root,dir),{mode:0o700})
for(const key of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key))delete process.env[key]
Object.assign(process.env,{MERIDIAN_CONFIG_DIR:join(root,'proxy'),MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_TELEMETRY_PERSIST:'0',
 MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_PASSTHROUGH:'1',MERIDIAN_NO_UPDATE_CHECK:'1'})
const queries=[],servedModels=new Set(),realQuery=sdk.query
const observer=spyOn(sdk,'query').mockImplementation(input=>{queries.push({profileMatched:input.options?.env?.CLAUDE_CODE_OAUTH_TOKEN===auth.accessToken,resume:!!input.options?.resume});return observeSdkModels(realQuery(input),servedModels)})
const pluginConfigPath=join(root,'plugins.json');writeFileSync(pluginConfigPath,JSON.stringify({plugins:[{path:scrub,enabled:true}]}),{mode:0o600})
const {startProxyServer}=await import('../dist/server.js')
let proxy,polling,children=[]
const snapshots=[]
async function run(id,prompt,session){
 const project=join(root,'project-'+id),config=join(root,'config-'+id)
 if(!session){mkdirSync(project,{mode:0o700});mkdirSync(config,{mode:0o700})
 writeFileSync(join(config,'opencode.json'),JSON.stringify({$schema:'https://opencode.ai/config.json',plugin:[resolve('dist/meridian')],
 model:`anthropic/${model}`,small_model:`anthropic/${model}`,share:'disabled',permission:'allow',provider:{anthropic:{options:{apiKey:'local-inflight-gate',baseURL:proxyUrl},
 models:{[model]:{name:model,limit:{context:200000,output:1024},reasoning:false,tool_call:true,modalities:{input:['text'],output:['text']}}}}}}),{mode:0o600})}
 const env={...process.env,OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1'}
 for(const kind of ['CONFIG','DATA','CACHE','STATE'])env['XDG_'+kind+'_HOME']=join(root,id+'-'+kind.toLowerCase())
 for(const key of Object.keys(env))if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key))delete env[key]
 const args=['run','--format','json',...(session?['--session',session]:[]),prompt]
 const child=spawn(client,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});children.push(child)
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
 const timeout=setTimeout(()=>child.kill('SIGKILL'),180000)
 const exit=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept)}).finally(()=>clearTimeout(timeout))
 writeFileSync(join(root,id+(session?'-continued':'')+'.stdout'),stdout,{mode:0o600});writeFileSync(join(root,id+(session?'-continued':'')+'.stderr'),stderr,{mode:0o600})
 const events=stdout.split('\n').filter(line=>line.startsWith('{')).flatMap(line=>{try{return[JSON.parse(line)]}catch(error){return[]}})
 return{exit,events,session:events.find(event=>typeof event.sessionID==='string')?.sessionID,text:events.filter(event=>event.type==='text').map(event=>event.part?.text??'').join('')}
}
let proxyUrl
try{
 proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:true,maxConcurrent:1,pluginConfigPath,pluginDir:join(root,'plugins'),
 profiles:[{id:'read-only-live',type:'oauth-token',oauthToken:auth.accessToken}],defaultProfile:'read-only-live'})
 if(!proxy.server.listening)await once(proxy.server,'listening');proxyUrl=`http://127.0.0.1:${proxy.server.address().port}`
 const observe=async()=>{const response=await fetch(proxyUrl+'/inflight');assert.equal(response.status,200);const value=await response.json();assert.equal(value.scope,'client-http');
 assert.equal(value.total,Object.values(value.upstreams).reduce((sum,count)=>sum+count.streams+count.requests+count.queued,0));snapshots.push(value);return value}
 const initial=await observe();assert.equal(initial.total,0)
 const forwarded=await fetch(proxyUrl+'/inflight',{headers:{'x-forwarded-for':'203.0.113.1'}});assert.equal(forwarded.status,403)
 const plugins=await(await fetch(proxyUrl+'/plugins/list')).json();assert(plugins.plugins.some(plugin=>plugin.name==='opencode-scrub'&&plugin.status==='active'))
 let pollingError
 polling=setInterval(()=>{observe().catch(error=>{pollingError=error})},20)
 const marker='INFLIGHT-'+randomUUID()
 const first=await Promise.all(['one','two'].map(id=>run(id,`Reply with exactly ${marker}. Do not use tools.`)))
 assert(first.every(result=>result.exit===0&&result.text.includes(marker)&&result.session),'An actual model response failed; private artifacts: '+root)
 const continued=await run('one','Repeat the exact marker from your previous answer without tools.',first[0].session)
 assert.equal(continued.exit,0);assert(continued.text.includes(marker),'Actual same-session continuation lost the marker')
 clearInterval(polling);polling=undefined;await new Promise(accept=>setTimeout(accept,50));if(pollingError)throw pollingError
 const final=await observe()
 const summary={result:'FAIL',platform:`${process.platform}/${process.arch}`,bun:Bun.version,opencode:version.stdout.trim(),model,
 sdk:JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json',import.meta.url),'utf8')).version,
 claudeCode:JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-code/package.json',import.meta.url),'utf8')).version,
 maximumTotal:Math.max(...snapshots.map(value=>value.total)),sawStream:snapshots.some(value=>value.upstreams.claude.streams>0),sawQueued:snapshots.some(value=>value.upstreams.claude.queued>0),
 finalTotal:final.total,observations:snapshots.length,forwardedRejected:forwarded.status===403,allQueriesUseReadOnlyProfile:queries.length>0&&queries.every(query=>query.profileMatched),
 servedModels:[...servedModels],realSdkQueries:queries.length,resumed:queries.some(query=>query.resume),clients:first.map(result=>({exit:result.exit,hasSession:!!result.session})),continuedExit:continued.exit,privateArtifacts:root}
 writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600})
 assert(summary.maximumTotal>=2&&summary.sawStream&&summary.sawQueued&&summary.finalTotal===0,'Missing actual overlapping active/queued/idle transitions: '+root)
 assert(summary.allQueriesUseReadOnlyProfile&&summary.resumed,'Actual SDK profile or continuation mismatch')
 assert(servedModels.size>0&&[...servedModels].every(value=>value===model||value.startsWith(model+'-')),'Upstream response did not confirm the implicated model')
 summary.result='PASS';writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary))
}finally{if(polling)clearInterval(polling);for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await proxy?.close();observer.mockRestore()}
