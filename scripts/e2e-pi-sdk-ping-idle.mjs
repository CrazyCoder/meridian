#!/usr/bin/env node
// Real headless Pi + real SDK/CLI, controlled API stall. Not a live model.
// E2E_PI_CLI=<Pi cli.js> E2E_CLAUDE_BIN=<2.1.283> [E2E_EXPECT_STALL=0] node this-file
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {createServer} from 'node:http'
import {once} from 'node:events'
const pi=process.env.E2E_PI_CLI,claude=process.env.E2E_CLAUDE_BIN
assert(pi&&claude,'Set actual Pi CLI and Claude binary paths')
const expectStall=process.env.E2E_EXPECT_STALL!=='0'
const root=mkdtempSync(join(tmpdir(),'meridian-pi-sdk-ping-'))
const config=join(root,'pi'),project=join(root,'project'),proxyConfig=join(root,'proxy'),claudeConfig=join(root,'claude')
for(const dir of [config,project,proxyConfig,claudeConfig])mkdirSync(dir)
const versions={pi:spawnSync(process.execPath,[pi,'--version'],{encoding:'utf8'}).stdout.trim(),claude:spawnSync(claude,['--version'],{encoding:'utf8'}).stdout.trim(),node:process.version}
assert(versions.claude.includes('2.1.283'),'Use the implicated Claude Code version')
let requests=0,pings=0,firstRequestAt
const timers=new Set()
const upstream=createServer((req,res)=>{
 if(!new URL(req.url,'http://fixture').pathname.endsWith('/messages')){res.setHeader('content-type','application/json');res.end('{"input_tokens":10}');return}
 requests++;firstRequestAt??=performance.now();req.resume()
 res.writeHead(200,{'content-type':'text/event-stream','request-id':'sdk-ping-fixture'})
 const ping=setInterval(()=>{pings++;res.write('event: ping\ndata: {"type":"ping"}\n\n')},250)
 const finish=setTimeout(()=>{
  clearInterval(ping);timers.delete(ping);timers.delete(finish)
  const events=[{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model:'claude-opus-5-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Fixture completed after stalled interval.'}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'}]
  res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
 },35000)
 timers.add(ping);timers.add(finish)
 res.on('close',()=>{clearInterval(ping);clearTimeout(finish);timers.delete(ping);timers.delete(finish)})
})
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
for(const key of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_)/.test(key))delete process.env[key]
Object.assign(process.env,{MERIDIAN_CONFIG_DIR:proxyConfig,MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_PASSTHROUGH:'1',MERIDIAN_UPSTREAM_IDLE_MS:'15000',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_CLAUDE_PATH:claude,CLAUDE_CONFIG_DIR:claudeConfig})
const {startProxyServer}=await import('../dist/server.js')
let proxy
try{
 proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:true,profiles:[{id:'fixture',type:'api',apiKey:'local-fixture',baseUrl:`http://127.0.0.1:${upstream.address().port}`}]})
 if(!proxy.server.listening)await once(proxy.server,'listening')
 const url=`http://127.0.0.1:${proxy.server.address().port}`
 writeFileSync(join(config,'models.json'),JSON.stringify({providers:{meridian:{baseUrl:url,apiKey:'local-fixture',api:'anthropic-messages',headers:{'x-session-affinity':'pi-sdk-ping-fixture'},models:[{id:'claude-opus-5-5',name:'Controlled fixture identifier',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}))
 writeFileSync(join(config,'settings.json'),JSON.stringify({compaction:{enabled:false},retry:{enabled:false}}))
 const env={...process.env,PI_CODING_AGENT_DIR:config,PI_OFFLINE:'1',ANTHROPIC_API_KEY:'local-fixture'}
 for(const key of Object.keys(env))if(/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|OPENAI_)/.test(key))delete env[key]
 const child=spawn(process.execPath,[pi,'--provider','meridian','--model','claude-opus-5-5','--mode','json','--print','--offline','--approve','--no-extensions','--no-skills','--no-prompt-templates','--thinking','off','--tools','','Give a brief acknowledgement without tools.'],{cwd:project,env,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c)
 const timeout=setTimeout(()=>child.kill('SIGKILL'),65000)
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});clearTimeout(timeout)
 writeFileSync(join(root,'client.stdout'),stdout,{mode:0o600});writeFileSync(join(root,'client.stderr'),stderr,{mode:0o600})
 const events=stdout.split('\n').filter(Boolean).flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}})
 const idleErrors=events.filter(e=>JSON.stringify(e).includes('upstream_timeout'))
 const completions=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant'&&e.message.stopReason!=='error')
 const elapsed=firstRequestAt===undefined?null:Math.round(performance.now()-firstRequestAt)
 const summary={expectStall,versions,platform:`${process.platform}/${process.arch}`,requests,pings,elapsed,exit,idleErrors:idleErrors.length,completions:completions.length,privateArtifacts:root,upstream:'controlled-local-API-not-live-model'}
 console.log(JSON.stringify({result:'observed',...summary}))
 assert(requests>0&&pings>20,'Real CLI did not reach the ping-only upstream')
 if(expectStall){assert(idleErrors.length>0,'Real Pi did not receive upstream_timeout');assert.equal(completions.length,0);assert(elapsed<30000,'Deadline was extended by incoming SDK pings')}
 else{assert.equal(idleErrors.length,0);assert(completions.length>0);assert(elapsed>=35000,'Baseline did not wait through the original idle deadline')}
 console.log(JSON.stringify({result:'PASS',...summary}))
}finally{await proxy?.close();for(const timer of timers){clearInterval(timer);clearTimeout(timer)}upstream.closeAllConnections();upstream.close()}
