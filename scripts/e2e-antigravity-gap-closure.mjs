// Live official-CLI gates for durability, background work, extensions and expanded tools.
import assert from 'node:assert/strict'
import { startProxyServer } from '../dist/server.js'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-gap-closure-')); console.log(root)
const passed = [], observed = []
const model = 'gemini-3.8-flash-low', instructions = 'Follow the user exactly. Do not use unrequested tools.'
let proxy, url
async function start() {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { statePath: join(root, 'state.sqlite'), allowToolBridge: true, plugins: [{ name: 'live-extension', onRequest({request}) { observed.push('request'); return request }, onResponse() { observed.push('response') }, onTelemetry() { observed.push('telemetry') } }] } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  url = 'http://127.0.0.1:' + proxy.server.address().port
}
async function post(body) {
  const response = await fetch(url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, instructions, ...body }), signal: AbortSignal.timeout(180000) })
  const wire = await response.text()
  await writeFile(join(root, randomUUID() + '.json'), JSON.stringify({body,status:response.status,wire},null,2))
  assert.equal(response.status, 200, wire)
  if (!body.stream) return JSON.parse(wire)
  const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  assert(!events.some(e=>e.type==='error'), wire)
  return events.find(e => e.type === 'response.completed')?.response
}
const text = response => response.output.filter(item=>item.type==='message').flatMap(item=>item.content).map(part=>part.text??'').join('').trim()
const mark = name => { passed.push(name); console.log('PASS',name) }
try {
  await start()
  const receipt = 'DURABLE_' + randomUUID()
  const first = await post({ input: 'Remember this receipt and reply exactly with it: ' + receipt })
  assert.equal(text(first),receipt)
  await proxy.close(); await start()
  assert.deepEqual(await (await fetch(url+'/v1/responses/'+first.id)).json(),first)
  const second = await post({ previous_response_id: first.id, input: 'Reply with exactly the receipt I asked you to remember.' })
  assert.equal(text(second),receipt)
  const health = await (await fetch(url+'/health')).json()
  assert.equal(health.restored,1,JSON.stringify(health))
  const summary = await (await fetch(url+'/telemetry/summary')).json()
  assert(summary.totalRequests>=2)
  mark('durable response IDs, native completed-session restoration and telemetry')
  await proxy.close(); await start()
  const canary = join(root, 'denied-canary.txt'), secret = 'SECRET_' + randomUUID()
  await writeFile(canary, secret)
  const denied = await fetch(url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, instructions, previous_response_id: second.id, input: 'For this guard validation, try the native view_file tool exactly once on ' + canary + '. Do not use client tools or shell. If denied, stop.' }), signal: AbortSignal.timeout(180000) })
  const denial = await denied.text(); await writeFile(join(root, 'resume-denial.json'), JSON.stringify({status:denied.status,denial}))
  assert(!denial.includes(secret), 'Unapproved native file content escaped')
  await proxy.close(); await start()
  let audited = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const activity = await (await fetch(url + '/telemetry/native-tools')).json()
    audited = activity.some(event => event.name === 'view_file' && event.state === 'denied')
    if (audited) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert(audited, 'Native resumed file-denial hook was not exercised')
  mark('native resumed CLI retains the file-denial policy')
  assert(observed.includes('request')&&observed.includes('response')&&observed.includes('telemetry'))
  const plugins = await (await fetch(url+'/plugins/list')).json()
  assert.equal(plugins[0].name,'live-extension'); mark('provider extension lifecycle')
  const backgroundReceipt='BACKGROUND_'+randomUUID()
  const job=await post({input:'Reply with exactly '+backgroundReceipt,background:true})
  assert.equal(job.status,'queued')
  const stream=await (await fetch(url+'/v1/responses/'+job.id+'?stream=true')).text()
  const terminal=stream.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==='response.completed')
  assert(terminal,stream);assert.equal(text(terminal.response),backgroundReceipt)
  const replay=await (await fetch(url+'/v1/responses/'+job.id+'?stream=true&starting_after=0')).text()
  assert(!replay.includes('event: response.created'));assert(replay.includes('response.completed'))
  const items=await (await fetch(url+'/v1/responses/'+job.id+'/input_items?order=asc&limit=1')).json()
  assert.equal(items.data.length,1);mark('background execution, streamed retrieval, event cursor and input listing')
  const cancelled = await post({input:'Write every integer from 1 through 10000, one per line, with no omissions.',background:true})
  for(let attempt=0;attempt<200;attempt++) {
    const health=await (await fetch(url+'/health')).json()
    if(health.activeProcesses>0) break
    await new Promise(resolve=>setTimeout(resolve,50))
    assert(attempt<199,'Background CLI never became active')
  }
  const cancellation=await (await fetch(url+'/v1/responses/'+cancelled.id+'/cancel',{method:'POST'})).json()
  assert.equal(cancellation.status,'cancelled',JSON.stringify(cancellation))
  const cancelledStream=await (await fetch(url+'/v1/responses/'+cancelled.id+'?stream=true')).text()
  assert(cancelledStream.includes('response.cancelled'))
  mark('active background CLI cancellation and terminal replay')
  for(const syntax of ['regex','lark']) {
    const definition=syntax==='regex'?'NOTE_[0-9]{4}':'start: "NOTE_1234"'
    const tools=[{type:'custom',name:'write_grammar',description:'Write exactly NOTE_1234',format:{type:'grammar',syntax,definition}}]
    const response=await post({input:'Call write_grammar with exactly NOTE_1234.',tools,tool_choice:{type:'custom',name:'write_grammar'}})
    const call=response.output.find(item=>item.type==='custom_tool_call')
    assert.equal(call?.input,'NOTE_1234',JSON.stringify(response))
    const receipt='GRAMMAR_'+randomUUID()
    const completed=await post({previous_response_id:response.id,input:[{type:'custom_tool_call_output',call_id:call.call_id,output:receipt}],tools})
    assert(text(completed).includes(receipt),JSON.stringify(completed))
    mark(syntax+' custom grammar and tool result')
  }
  for(const custom of [false,true]) {
    const tool=custom?{type:'custom',name:'write_note',description:'Write the complete text of a note',format:{type:'text'}}:{type:'function',name:'read_receipt',description:'Read the receipt',parameters:{type:'object',properties:{},additionalProperties:false}}
    const tools=[{type:'namespace',name:'fixture',tools:[tool]}]
    const first=await post({input:custom?'Call fixture.write_note with exactly hello world. Then echo the returned receipt.':'Call fixture.read_receipt. Then echo the returned receipt.',tools,tool_choice:{type:tool.type,namespace:'fixture',name:tool.name},stream:true})
    const call=first.output.find(i=>i.type===(custom?'custom_tool_call':'function_call'));assert(call,JSON.stringify(first));assert.equal(call.namespace,'fixture')
    if(custom) { assert.equal(call.input.trim(),'hello world'); await writeFile(join(root,'note.txt'),call.input) }
    const receipt='TOOL_'+randomUUID()
    const second=await post({previous_response_id:first.id,input:[custom?{type:'custom_tool_call_output',call_id:call.call_id,output:receipt}:{type:'function_call_output',call_id:call.call_id,output:[{type:'input_text',text:receipt}]}],tools})
    assert.equal(text(second),receipt)
    mark(custom?'namespaced freeform tool and exact result continuation':'namespaced function tool and array result continuation')
  }
} finally { if(proxy)await proxy.close();await writeFile(join(root,'report.json'),JSON.stringify({model,passed,observed},null,2)) }
