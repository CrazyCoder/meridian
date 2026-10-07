#!/usr/bin/env bun
// Actual Claude Code 2.1.287 interactive connector-text requests, real SDK and
// bundled subprocess. Python provides a PTY, not a synthetic HTTP client.
// E2E_CLAUDE_CLIENT=/path/to/2.1.287 E2E_PROFILE_CLAUDE_DIR=/owned/credentials \
//   bun scripts/e2e-thinking-display-interactive.mjs
// Run the same harness against unchanged main with E2E_MERIDIAN_ROOT and
// E2E_EXPECT_DISPLAY_FAILURE=1; that requires the exact native CLI rejection.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

assert.notEqual(process.platform, 'win32', 'This interactive PTY gate needs a POSIX host')
const client = realpathSync(process.env.E2E_CLAUDE_CLIENT)
const credentials = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const source = realpathSync(process.env.E2E_MERIDIAN_ROOT ?? resolve('.'))
const model = process.env.E2E_MODEL ?? 'claude-sonnet-5'
const mode = process.env.E2E_DISPLAY_MODE ?? 'updates'
const expectedFailure = process.env.E2E_EXPECT_DISPLAY_FAILURE === '1'
const clientMode = process.env.E2E_CLIENT_MODE ?? 'interactive'
assert(['interactive', 'print'].includes(clientMode))
assert(clientMode !== 'print' || mode === 'omitted', 'Print mode is only the omitted-display control')
assert(mode !== 'omitted' || clientMode === 'print', 'Interactive 2.1.287 sends updates for omitted; use E2E_CLIENT_MODE=print')
assert(['updates','summarized','omitted','highlights','disabled'].includes(mode))
assert(!expectedFailure || mode === 'updates', 'Only the unknown-display case should fail on main')
const version = spawnSync(client, ['--version'], {encoding:'utf8'})
assert.equal(version.status, 0)
assert.equal(version.stdout.trim(), '2.1.287 (Claude Code)')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-thinking-interactive-')))
const project = join(root,'project'), config = join(root,'client-config')
for (const path of [project,config]) mkdirSync(path,{mode:0o700})
const receipt = 'THINKING-' + randomUUID()
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env,{MERIDIAN_CONFIG_DIR:join(root,'proxy-config'), MERIDIAN_SESSION_DIR:join(root,'sessions'),
  MERIDIAN_WORKDIR:project,CLAUDE_CONFIG_DIR:join(root,'unlinked-default'),MERIDIAN_PASSTHROUGH:'1',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_TELEMETRY_PERSIST:'0'})
const logs=[], wire=[], queries=[], nativeModels=new Set()
const savedConsole={log:console.log,error:console.error,warn:console.warn,debug:console.debug}
for(const key of Object.keys(savedConsole)) console[key]=(...args)=>logs.push(args.map(String).join(' '))
const actualQuery=sdk.query
const observer=spyOn(sdk,'query').mockImplementation(input=>{
  const text=typeof input.prompt==='string'?input.prompt:undefined
  const receiptIndex=text?.indexOf(receipt)??-1
  const historyEnd=text?.indexOf('</conversation_history>')??-1
  const fact={thinking:input.options?.thinking??null,credentialDirectoryMatched:input.options?.env?.CLAUDE_CONFIG_DIR===credentials,
    promptReceiptInsideHistory:text===undefined?null:receiptIndex>=0 && historyEnd>receiptIndex,models:[]}
  queries.push(fact)
  const query=actualQuery(input)
  return new Proxy(query,{get(target,key){
    if(key===Symbol.asyncIterator)return async function*(){
      for await(const message of query){
        if(message.type==='assistant' && typeof message.message?.model==='string'){
          nativeModels.add(message.message.model)
          if(!fact.models.includes(message.message.model))fact.models.push(message.message.model)
        }
        yield message
      }
    }
    const value=Reflect.get(target,key,target)
    return typeof value==='function'?value.bind(target):value
  }})
})
let server, proxy, child, closed
try {
  const {startProxyServer}=await import(pathToFileURL(join(source,'dist/server.js')).href)
  proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:false,
    profiles:[{id:'owned-thinking',claudeConfigDir:credentials}],defaultProfile:'owned-thinking'})
  if(!proxy.server.listening)await once(proxy.server,'listening')
  const upstreamUrl='http://127.0.0.1:'+proxy.server.address().port
  // Observe bytes in a Node HTTP relay without changing the actual client's
  // thinking, request body, status or streamed model response. Join aborted
  // upstream connections rather than leaving a response.clone() tee alive.
  server=createServer(async(request,response)=>{
    try {
      const path=new URL(request.url,'http://127.0.0.1').pathname
      if(path==='/__thinking_display_proof'){response.setHeader('content-type','application/json');response.end(JSON.stringify(wire));return}
      if(path.endsWith('/count_tokens')){response.setHeader('content-type','application/json');response.end(JSON.stringify({input_tokens:4000}));return}
      const input=[];let inputSize=0
      for await(const chunk of request){inputSize+=chunk.length;assert(inputSize<=2*1024*1024,'Client request exceeded fixture bound');input.push(chunk)}
      const bytes=Buffer.concat(input)
      let fact
      if(request.method==='POST' && path.endsWith('/messages')){
        const body=JSON.parse(bytes.toString())
        fact={thinking:body.thinking??null,model:body.model,client:request.headers['user-agent'],stream:body.stream,
          messageRoles:body.messages?.map(message=>message.role),
          status:null,errorEvent:false,receipt:false,unsupportedDisplay:false,aborted:false}
        wire.push(fact)
      }
      const upstream=httpRequest(upstreamUrl+request.url,{method:request.method,headers:request.headers},incoming=>{
        response.writeHead(incoming.statusCode,incoming.headers)
        const output=[];let outputSize=0
        incoming.on('data',chunk=>{
          outputSize+=chunk.length
          if(outputSize>2*1024*1024){upstream.destroy(new Error('Model response exceeded fixture bound'));return}
          if(fact)output.push(chunk)
          response.write(chunk)
        })
        incoming.on('end',()=>{
          if(fact){
            const raw=Buffer.concat(output).toString()
            const events=raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)))
            const text=events.filter(event=>event.delta?.type==='text_delta').map(event=>event.delta.text).join('')
            fact.status=incoming.statusCode;fact.receipt=text.includes(receipt)
            fact.errorEvent=events.some(event=>event.type==='error')
            fact.unsupportedDisplay=raw.includes("argument 'updates' is invalid")
          }
          response.end()
        })
        incoming.on('error',error=>{logs.push('relay response: '+error.message);response.destroy()})
      })
      upstream.on('error',error=>{logs.push('relay request: '+error.message);response.destroy()})
      response.once('close',()=>{if(!response.writableFinished){if(fact)fact.aborted=true;upstream.destroy()}})
      upstream.end(bytes)
    }catch(error){logs.push('relay: '+error.message);response.destroy()}
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const url='http://127.0.0.1:'+server.address().port
  child=spawn('python3',[join(dirname(fileURLToPath(import.meta.url)),'e2e-thinking-display-interactive-driver.py'),
    client,project,config,url,receipt,mode,expectedFailure?'1':'0',clientMode],{env:{...process.env,E2E_MODEL:model},stdio:['ignore','pipe','pipe']})
  closed=new Promise(accept=>child.once('close',accept))
  let stdout='',stderr=''
  child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk})
  const exit=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept)})
  await closed
  writeFileSync(join(root,'driver.stderr'),stderr,{mode:0o600})
  assert.equal(exit,0,'Interactive driver failed; private fixture '+root)
  const terminal=JSON.parse(stdout.trim())
  const actual=wire.filter(fact=>mode==='disabled'?fact.thinking?.type==='disabled':fact.thinking?.type==='adaptive' && fact.thinking?.display===mode)
  assert(actual.length>0,'Actual client did not emit the required thinking configuration')
  assert(wire.every(fact=>fact.client?.startsWith('claude-cli/2.1.287')))
  assert(queries.length>0 && queries.every(fact=>fact.credentialDirectoryMatched),'SDK used a different account fixture')
  if(expectedFailure){
    assert(actual.some(fact=>fact.unsupportedDisplay),'Baseline did not fail for the native thinking-display rejection')
    assert(queries.some(fact=>fact.thinking?.display==='updates'))
  } else {
    assert(terminal.receiptDelivered,'Actual client did not deliver the receipt')
    assert(actual.some(fact=>fact.status===200 && fact.receipt && !fact.errorEvent),'Main interactive turn lost its receipt')
    assert(!actual.some(fact=>fact.unsupportedDisplay || fact.errorEvent),'Interactive request still failed')
    assert(nativeModels.has(model),'Upstream served a different native model')
    const relevantQueries=queries.filter(fact=>mode==='disabled'?fact.thinking?.type==='disabled':fact.thinking?.type==='adaptive')
    assert(relevantQueries.some(fact=>fact.models.includes(model) && fact.promptReceiptInsideHistory===false),'Current user request was not delivered as a live prompt to the required native model')
    if(mode==='updates'){
      assert(queries.some(fact=>fact.thinking?.type==='adaptive' && fact.thinking.display===undefined))
      assert(!queries.some(fact=>fact.thinking?.display==='updates'))
      assert(logs.some(line=>line.includes('thinking display "updates" dropped')))
    } else {
      assert(!logs.some(line=>line.includes('thinking display') && line.includes('dropped')))
      assert(queries.some(fact=>mode==='disabled'?fact.thinking?.type==='disabled':fact.thinking?.display===mode))
    }
  }
  const deadline=Date.now()+10000
  while((await(await fetch(upstreamUrl+'/inflight')).json()).total!==0 && Date.now()<deadline)await new Promise(accept=>setTimeout(accept,25))
  assert.equal((await(await fetch(upstreamUrl+'/inflight')).json()).total,0,'SDK cleanup did not join')
  const summary={result:'PASS',root,platform:process.platform,version:version.stdout.trim(),mode,expectedFailure,
    actualInteractive:clientMode==='interactive',clientMode,terminal,wire,queries,nativeModels:[...nativeModels],joinedCleanup:true}
  writeFileSync(join(root,'proof.json'),JSON.stringify(summary,null,2),{mode:0o600})
  savedConsole.log(JSON.stringify(summary))
} finally {
  writeFileSync(join(root,'observations.json'),JSON.stringify({wire,queries,nativeModels:[...nativeModels]},null,2),{mode:0o600})
  if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')
  if(closed)await closed
  if(server){server.closeAllConnections();await new Promise(accept=>server.close(accept))}
  await proxy?.close()
  observer.mockRestore()
  Object.assign(console,savedConsole)
}
