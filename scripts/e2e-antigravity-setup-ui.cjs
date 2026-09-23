// Run with the actual Electron binary after both builds. Attach to an owned
// subscription-backed Antigravity service via E2E_MERIDIAN_URL (service root).
const { app, BrowserWindow, clipboard } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const repo = resolve(__dirname, '..'), endpoint = process.env.E2E_MERIDIAN_URL
assert(endpoint, 'Provide E2E_MERIDIAN_URL for an owned live service')
const root = mkdtempSync(join(tmpdir(), 'meridian-agy-setup-ui-'))
app.setPath('userData', root)
mkdirSync(join(root, 'preview'))
writeFileSync(join(root, 'preview/desktop.json'), JSON.stringify({mode:'attached',endpoint,autoStart:false,openWindowAtLaunch:true}))
console.log('Artifacts: '+root)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) { const end=Date.now()+90000; while(Date.now()<end){const value=await fn();if(value)return value;await delay(200)}throw new Error('Desktop setup UI deadline exceeded: '+fn.toString()) }
async function runClient(binary, args, options) {
  const child=spawn(binary,args,{...options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',bytes=0,killTimer,stopping=false
  const kill=signal=>{try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal)}catch(error){if(error.code!=='ESRCH')throw error}}
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000)}
  const timer=setTimeout(stop,180000)
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024)stop();else stdout+=chunk})
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024)stop();else stderr+=chunk})
  try {return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',status=>resolve({status,stdout,stderr}))})}
  finally {clearTimeout(timer);clearTimeout(killTimer)}
}
async function main() {
  require(join(repo, 'apps/desktop/dist/main.cjs'))
  const window=await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html')))
  const js=async source=>{try{return await window.webContents.executeJavaScript(source)}catch(error){console.error('Failed desktop expression:',source);throw error}}
  await until(()=>!window.webContents.isLoading())
  await until(async()=>{const s=await js('window.meridian.state()');return s.providers?.providers.find(p=>p.id==='antigravity'&&p.models?.length)})
  await until(()=>js(`!!document.querySelector('[data-page="Providers"]')`))
  await js(`document.querySelector('[data-page="Providers"]').click()`)
  await until(()=>js(`!!document.querySelector('[data-provider="antigravity"]')`))
  await js(`document.querySelector('[data-provider="antigravity"]').click()`)
  await js(`const d=document.querySelector('.provider-setup');d.open=true;d.scrollIntoView({block:'center'})`)
  const node=join(repo,'apps/desktop/node_modules/node/bin/node')
  const bin=join(root,'bin');mkdirSync(bin)
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'"
  writeFileSync(join(bin,'meridian'),`#!/bin/sh\nexec ${quote(node)} ${quote(join(repo,'dist/cli.js'))} "$@"\n`,{mode:0o700})
  const model='gemini-3.8-flash-low'
  const commands={}
  for(const client of ['pi','opencode']) {
    await js(`(()=>{const f=document.querySelector('.provider-client-setup');f.elements['agy-client'].value=${JSON.stringify(client)};f.elements['agy-model'].value=${JSON.stringify(model)};f.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    const command=await js(`document.querySelector('[data-setup-command]').value`)
    assert(command.includes(`--client ${client}`)&&command.includes(`--model '${model}'`),command)
    assert(!command.includes('--set-default'))
    await js(`document.querySelector('[data-setup-copy]').click()`)
    await until(async()=>await js(`document.querySelector('[data-setup-status]').textContent`)==='Copied')
    assert.equal(await clipboard.readText(),command)
    commands[client]=command
    const config=join(root,client);mkdirSync(config)
    const env={...process.env,PATH:bin+':'+join(repo,'apps/desktop/node_modules/node/bin')+':'+process.env.PATH}
    for(const key of Object.keys(env))if(/^(OPENCODE_|PI_CODING_AGENT_DIR|ANTHROPIC_|CLAUDE_|MERIDIAN_)/.test(key))delete env[key]
    const setup=spawnSync('/bin/sh',['-c',command+' --config-dir '+quote(config)],{env,encoding:'utf8',timeout:30000})
    writeFileSync(join(root,client+'-setup.log'),setup.stdout+setup.stderr)
    assert.equal(setup.status,0,setup.stderr)
    const data=JSON.parse(readFileSync(join(config,client==='pi'?'models.json':'opencode.json'),'utf8'))
    const provider=data[client==='pi'?'providers':'provider']['meridian-agy']
    assert.equal(client==='pi'?provider.baseUrl:provider.options.baseURL,endpoint+(client==='pi'?'':'/v1'))
    console.log('PASS actual desktop clipboard command configures '+client)
    if(process.env.E2E_AGY_SETUP_UI_CLIENTS==='1') {
      const home=join(root,client+'-home'), project=join(root,client+'-project');mkdirSync(home);mkdirSync(project)
      Object.assign(env,{VOLTA_HOME:process.env.VOLTA_HOME||join(require('node:os').homedir(),'.volta'),HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),XDG_STATE_HOME:join(home,'.local/state'),XDG_CACHE_HOME:join(home,'.cache'),PI_CODING_AGENT_DIR:config,PI_OFFLINE:'1',PI_TELEMETRY:'0',OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1'})
      const marker='UI_READY_'+client.toUpperCase()
      const args=client==='pi'?['--provider','meridian-agy','--model',model,'--thinking','off','--no-session','--no-tools','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','-p',`Reply exactly ${marker}. Do not use tools.`]:['run','--format','json','--model','meridian-agy/'+model,`Reply exactly ${marker}. Do not use tools.`]
      const binary=client==='pi'?process.env.E2E_PI_BIN||'pi':process.env.E2E_OPENCODE_BIN||'opencode'
      const version=spawnSync(binary,['--version'],{env,encoding:'utf8',timeout:10000})
      assert.equal(version.status,0,version.stderr)
      console.log('Client version:',client,(version.stdout||version.stderr).trim())
      const run=await runClient(binary,args,{cwd:project,env})
      writeFileSync(join(root,client+'-live.log'),run.stdout+run.stderr)
      assert.equal(run.status,0,run.stderr)
      assert(run.stdout.includes(marker),run.stdout)
      console.log('PASS actual '+client+' uses desktop-generated configuration with official agy')
    }
  }
  await js(`(()=>{const f=document.querySelector('.provider-client-setup');f.elements['agy-default'].checked=true;f.elements['agy-key-env'].value='LOCAL_KEY';f.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const before=await js(`document.querySelector('[data-setup-command]').value`)
  assert(before.includes('--api-key-env LOCAL_KEY --set-default'))
  await js(`window.meridian.action('refresh')`)
  await delay(250)
  assert.equal(await js(`document.querySelector('[data-setup-command]').value`),before)
  assert(await js(`document.querySelector('.provider-setup').open`))
  await js(`(()=>{const f=document.querySelector('.provider-client-setup');f.elements['agy-key-env'].value='not-a-variable';f.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  assert(await js(`document.querySelector('[data-setup-copy]').disabled`))
  await js(`(()=>{const f=document.querySelector('.provider-client-setup');f.elements['agy-key-env'].value='';f.dispatchEvent(new Event('input',{bubbles:true}));f.scrollIntoView({block:'center'});})()`)
  writeFileSync(join(root,'desktop-setup.png'),(await window.webContents.capturePage()).toPNG())
  writeFileSync(join(root,'commands.json'),JSON.stringify(commands,null,2))
  console.log('PASS desktop choices survive refresh; invalid variable blocks copying')
}
main().then(()=>app.exit(0)).catch(async error=>{console.error(error);const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'));if(window)writeFileSync(join(root,'failure.png'),(await window.webContents.capturePage()).toPNG());app.exit(1)})
