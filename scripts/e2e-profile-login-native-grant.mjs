#!/usr/bin/env bun
// Capture/verify only inside the owned fixture. The private before file contains
// grant values (0600); stdout and the final evidence contain booleans only.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPlatformCredentialStore } from '../src/proxy/tokenRefresh.ts'
const root = realpathSync(process.env.E2E_EXISTING_ROOT)
const id = process.env.E2E_PROFILE_ID
const mapping = readFileSync(join(root, 'config/profiles.json'), 'utf8')
const profile = JSON.parse(mapping).find(profile => profile.id === id)
assert(profile?.claudeConfigDir?.startsWith(root + '/'), 'Credentials must belong to the owned fixture')
const saved = await createPlatformCredentialStore({ claudeConfigDir: profile.claudeConfigDir }).read()
assert(saved?.claudeAiOauth?.accessToken && saved?.claudeAiOauth?.refreshToken, 'Native grant missing')
const beforePath = process.env.E2E_BEFORE_GRANT_FILE || join(root, 'reauth-before-private.json')
assert(beforePath.startsWith(root + '/'), 'Before control must stay in the owned fixture')
if (process.env.E2E_GRANT_ACTION === 'capture') {
  assert(!existsSync(beforePath), 'Refuse to overwrite an existing before control')
  writeFileSync(beforePath, JSON.stringify({ mapping, saved }), { mode: 0o600 })
  console.log(JSON.stringify({ captured: true, privateFile: true }))
} else {
  assert.equal(process.env.E2E_GRANT_ACTION, 'verify')
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  assert.equal(mapping, before.mapping)
  assert.notEqual(saved.claudeAiOauth.accessToken, before.saved.claudeAiOauth.accessToken)
  assert.notEqual(saved.claudeAiOauth.refreshToken, before.saved.claudeAiOauth.refreshToken)
  assert(saved.claudeAiOauth.expiresAt > Date.now())
  if (process.platform === 'darwin') assert(!existsSync(join(profile.claudeConfigDir, '.credentials.json')))
  console.log(JSON.stringify({ result: 'PASS', mappingUnchanged: true, accessGrantChanged: true,
    refreshGrantChanged: true, freshExpiry: true, nativeStore: process.platform === 'darwin' ? 'macOS Keychain' : 'platform file store' }))
}
