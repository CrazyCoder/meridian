/** macOS-only real launchd handoff and registry plugin installation probe.
 * Uses a disposable LaunchAgent and isolated configuration; never adopts an
 * existing user service. No model calls. E2E_DESKTOP_INSTALL is a directory
 * containing node_modules/@rynfar/meridian from an installed release.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { Manager } from '../apps/desktop/src/manager'
import { listeningPid } from '../apps/desktop/src/migration'
const exec = promisify(execFile)
assert.equal(process.platform, 'darwin')
assert.ok(process.argv.includes('--live'), 'Pass --live to create a disposable user LaunchAgent and install npm plugins.')
assert.ok(process.env.E2E_DESKTOP_INSTALL, 'Set E2E_DESKTOP_INSTALL to an installed Meridian directory.')
const installed = resolve(process.env.E2E_DESKTOP_INSTALL)
const manifest = JSON.parse(await readFile(join(installed, 'node_modules/@rynfar/meridian/package.json'), 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'meridian-handoff-'))
const node = resolve('apps/desktop/node_modules/node/bin/node')
const npm = resolve('apps/desktop/node_modules/npm/bin/npm-cli.js')
const runner = resolve('apps/desktop/dist/runner.mjs')
const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port
await new Promise<void>(done => server.close(() => done()))
const label = 'dev.meridian.desktop.e2e.' + process.pid
const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist')
const domain = `gui/${process.getuid?.()}`
const config = join(root, 'plugins.json'); await writeFile(config, '{"plugins":[]}')
const agent = { Label:label, ProgramArguments:[node, join(installed, 'node_modules/@rynfar/meridian/dist/cli.js')], WorkingDirectory:root, RunAtLoad:true, KeepAlive:true, ExitTimeOut:60, EnvironmentVariables:{MERIDIAN_PORT:String(port),MERIDIAN_HOST:'127.0.0.1',MERIDIAN_API_KEY:'',MERIDIAN_PLUGIN_CONFIG:config,MERIDIAN_PLUGIN_DIR:join(root,'plugins')}, StandardOutPath:join(root,'service.log'),StandardErrorPath:join(root,'service.log') }
await writeFile(plist, JSON.stringify(agent), {flag:'wx',mode:0o600}); await exec('/usr/bin/plutil',['-convert','xml1',plist])
const manager = new Manager({directory:join(root,'desktop'), node,npm,runner,desktopVersion:'e2e', encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString(),changed:()=>{},notify:()=>{}})
async function healthy() {
  for(let i=0;i<150;i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if(response.ok) return await response.json() } catch { /* Wait for the disposable service. */ }
    await new Promise(done=>setTimeout(done,200))
  }
  throw new Error('Disposable service did not become healthy; see ' + root)
}
try {
  await exec('/bin/launchctl',['bootstrap',domain,plist]); await healthy()
  const original = await listeningPid(port); assert.ok(original)
  await mkdir(join(root,'desktop/versions'),{recursive:true}); await symlink(installed,join(root,'desktop/versions',manifest.version))
  await manager.init(); await manager.configure({mode:'attached',endpoint:`http://127.0.0.1:${port}`})
  await manager.inspectOwnership(); assert.equal(manager.state.migration?.canAdopt,true)
  await manager.takeOwnership(); assert.equal(manager.snapshot().owned,true); assert.notEqual(await listeningPid(port),original)
  console.log('PASS: launchd to desktop handoff', manifest.version)
  for(const id of ['pi','opencode','hermes','openclaw']) {
    await manager.installPlugin(id+'-scrub')
    const plugins = await manager.api('/plugins/list') as {plugins:{name:string;status:string}[]}
    assert.ok(plugins.plugins.some(plugin=>plugin.name===id+'-scrub' && plugin.status==='active'))
    console.log('PASS: registry installation and live reload',id)
  }
  const beforeReturn = JSON.parse(await readFile(join(root,'desktop/desktop.json'),'utf8'))
  await manager.returnHeadless(); assert.equal(manager.snapshot().owned,false); await healthy()
  assert.equal(manager.state.migration?.canAdopt,true)
  const retained = await manager.api('/plugins/list') as {plugins:{name:string;status:string}[]}
  for (const id of ['pi','opencode','hermes','openclaw']) assert.ok(retained.plugins.some(plugin => plugin.name === id+'-scrub' && plugin.status === 'active'))
  console.log('PASS: desktop to original launchd supervisor; all four plugins retained')
  // Reproduce a crash after bootstrap but before clearing the durable journal.
  const secrets = JSON.parse(Buffer.from(beforeReturn.secret,'base64').toString())
  secrets.handoff.phase = 'returning'
  beforeReturn.secret = Buffer.from(JSON.stringify(secrets)).toString('base64')
  await writeFile(join(root,'desktop/desktop.json'), JSON.stringify(beforeReturn))
  const recovered = new Manager(manager.options)
  await recovered.init()
  assert.equal(recovered.state.error, undefined)
  assert.equal(recovered.preferences.mode, 'attached')
  assert.equal(recovered.state.migration?.canAdopt, true)
  await recovered.shutdown()
  console.log('PASS: interrupted return recovers an already restarted supervisor')
} finally {
  await manager.shutdown()
  try { await exec('/bin/launchctl',['bootout',`${domain}/${label}`]) } catch { /* May already be unloaded after a failed handoff. */ }
  await exec('/bin/launchctl',['enable',`${domain}/${label}`])
  await rm(plist,{force:true})
  console.log('Evidence:',root)
}
