// Native macOS startup gate, with disposable preferences and no model calls.
// npm run build --prefix apps/desktop
// env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron scripts/e2e-desktop-dock.cjs
// Repeat with E2E_HIDE_DOCK=0 to check the default Dock-visible mode.
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = mkdtempSync(join(tmpdir(), 'meridian-dock-'))
const hideDockIcon = process.env.E2E_HIDE_DOCK !== '0'
app.setPath('userData', root)
mkdirSync(join(root, 'preview'))
writeFileSync(join(root, 'preview/desktop.json'), JSON.stringify({
  mode: 'attached', endpoint: 'http://127.0.0.1:1', selected: '1.78.0',
  hideDockIcon, openWindowAtLaunch: false, autoStart: false,
}))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  assert.equal(process.platform, 'darwin', 'Run this gate on macOS')
  require(resolve(__dirname, '../apps/desktop/dist/main.cjs'))
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const windows = BrowserWindow.getAllWindows()
    ready = windows.length === 2 && windows.every(window => window.webContents.getURL().endsWith('.html') && !window.webContents.isLoading())
    if (ready) break
    await delay(100)
  }
  assert(ready, 'Dashboard and menu-bar panel loaded')
  await delay(1200)
  assert.equal(app.dock.isVisible(), !hideDockIcon, 'Native Dock visibility matches persisted preference')
  assert(BrowserWindow.getAllWindows().every(window => !window.isVisible()), 'Dashboard stays closed on menu-bar launch')
  const dashboard = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))
  app.emit('activate')
  assert(dashboard.isVisible(), 'App activation opens dashboard')
  assert.equal(app.dock.isVisible(), !hideDockIcon, 'Opening dashboard preserves Dock preference')
  dashboard.close()
  assert(!dashboard.isDestroyed() && !dashboard.isVisible(), 'Close hides dashboard without quitting')
  app.emit('second-instance')
  assert(dashboard.isVisible(), 'Second launch reopens dashboard')
  assert.equal(app.dock.isVisible(), !hideDockIcon, 'Reopening preserves Dock preference')
  const report = { platform: process.platform, electron: process.versions.electron, hideDockIcon, passed: ['native Dock visibility', 'dashboard and menu-bar panel loaded', 'background startup', 'activation and second launch reopen dashboard', 'close keeps app alive'] }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
