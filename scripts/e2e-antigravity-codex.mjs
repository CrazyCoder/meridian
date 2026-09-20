// Actual Codex CLI acceptance through the subscription-backed local Responses route.
import assert from 'node:assert/strict'
import { startProxyServer } from '../dist/server.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
const root=await mkdtemp(join(tmpdir(),'meridian-agy-codex-'));console.log(root)
const home=join(root,'codex-config'), workspace=join(root,'workspace');await mkdir(home);await mkdir(workspace)
const proxy=await startProxyServer({backend:'antigravity',port:0,silent:true,antigravity:{allowToolBridge:true}})
if(!proxy.server.listening)await once(proxy.server,'listening')
const base='http://127.0.0.1:'+proxy.server.address().port
let requests=0
const capture=createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=Buffer.concat(chunks)
  if(payload.length)await writeFile(join(root,'request-'+(++requests)+'.json'),payload)
  const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value&&key!=='host'&&key!=='content-length')headers.set(key,Array.isArray(value)?value.join(','):value)
  const result=await fetch(base+req.url,{method:req.method,headers,body:payload.length?payload:undefined})
  res.writeHead(result.status,Object.fromEntries(result.headers))
  if(!result.ok){const text=await result.text();await writeFile(join(root,'error-'+requests+'.json'),text);res.end(text);return}
  if(result.body)for await(const chunk of result.body)res.write(chunk)
  res.end()
 }catch(error){res.writeHead(502);res.end(String(error))}
})
await new Promise(resolve=>capture.listen(0,'127.0.0.1',resolve))
const provider=JSON.stringify('http://127.0.0.1:'+capture.address().port+'/v1')
let child
try {
 const env={...process.env,CODEX_HOME:home};delete env.OPENAI_API_KEY
 child=spawn('codex',['exec','--json','--skip-git-repo-check','-C',workspace,'-s','workspace-write','-m','gemini-3.8-flash-low','-c','model_provider="meridian"','-c',`model_providers.meridian={name="Meridian",base_url=${provider},wire_api="responses",requires_openai_auth=false}`,'-c','model_reasoning_effort="low"','-c','web_search="disabled"','Use the shell tool to create note.txt containing exactly BEFORE. Then use apply_patch to change it to exactly AFTER followed by a newline. Read the file with a shell command to verify it. Do not access the network or files outside this working directory. Finally reply exactly CODEX_COMPLETE.'],{cwd:workspace,env,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c)
 const timer=setTimeout(()=>child.kill('SIGTERM'),180000)
 const[code]=await once(child,'close');clearTimeout(timer)
 await writeFile(join(root,'codex.json'),JSON.stringify({code,stdout,stderr,requests},null,2))
 assert.equal(code,0,stderr+'\n'+stdout)
 assert.equal(await readFile(join(workspace,'note.txt'),'utf8'),'AFTER\n')
 assert(stdout.includes('CODEX_COMPLETE'),stdout)
 console.log('PASS actual Codex shell, patch, readback and final response')
}finally{child?.kill('SIGTERM');capture.closeAllConnections();await new Promise(resolve=>capture.close(resolve));await proxy.close()}
