#!/usr/bin/env bun
// Real HTTP + Claude auth-status + owned native Keychain/file metadata.
// The default-store factory is redirected to our own synthetic account; the
// host's default credential item is never read, written, or replaced.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spyOn } from 'bun:test'
const sourceRoot = resolve(process.env.E2E_SOURCE_ROOT || new URL('..', import.meta.url).pathname)
const expectLeak = process.env.E2E_EXPECT_METADATA_LEAK === '1'
const servePort = process.env.E2E_SERVE_PORT ? Number(process.env.E2E_SERVE_PORT) : undefined
if (servePort !== undefined) assert(Number.isInteger(servePort) && servePort > 1024 && servePort < 65536)
const source = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(source.status, 0)
const sourceHead = source.stdout.trim()
if (process.env.E2E_SOURCE_SHA) assert.equal(sourceHead, process.env.E2E_SOURCE_SHA)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-api-metadata-')))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  CLAUDE_CONFIG_DIR: join(root, 'cli-empty'), MERIDIAN_NO_UPDATE_CHECK: '1',
  MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_CREDENTIALS_READONLY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' })
mkdirSync(process.env.CLAUDE_CONFIG_DIR)
const at = rel => pathToFileURL(join(sourceRoot, rel)).href
const tokens = await import(at('src/proxy/tokenRefresh.ts'))
const models = await import(at('src/proxy/models.ts'))
const sdk = await import('@anthropic-ai/claude-agent-sdk')
const sdkSpy = spyOn(sdk, 'query').mockImplementation(() => { throw new Error('Metadata must not query a model') })
const nativeDir = join(root, 'owned-native-account'); mkdirSync(nativeDir)
const nativeStore = tokens.createPlatformCredentialStore({ claudeConfigDir: nativeDir })
const nativeService = tokens.configDirToKeychainService(nativeDir)
assert.notEqual(nativeService, 'Claude Code-credentials')
let defaultFallbacks = 0, nativeReads = 0
const factorySpy = spyOn(tokens, 'createPlatformCredentialStore').mockImplementation(opts => {
  assert(!opts?.claudeConfigDir, 'API metadata unexpectedly selected a stored account directory')
  defaultFallbacks++
  return { read: async () => { nativeReads++; return nativeStore.read() },
    write: async () => { throw new Error('HTTP metadata must not write credentials') } }
})
const { createProxyServer } = await import(at('src/proxy/server.ts'))
const cases = []
let listener, itemWritten = false
try {
  for (const scenario of ['unrelated-plan', 'unrelated-empty-grant']) {
    tokens.resetAuthRenewalCache(); models.resetCachedClaudeAuthStatus()
    const now = Date.now()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    const written = await nativeStore.write({ claudeAiOauth: { accessToken: scenario === 'unrelated-plan' ? 'owned-synthetic-access' : '',
      refreshToken: 'owned-synthetic-refresh', expiresAt: now + 3_600_000,
      refreshTokenExpiresAt: now + 86_400_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } })
    process.env.MERIDIAN_CREDENTIALS_READONLY = '1'
    assert(written, 'Cannot write owned native fixture'); itemWritten = true
    const profile = { id: `api-${scenario}`, type: 'api', apiKey: 'owned-synthetic-api-key-not-valid-for-inference' }
    const { app } = createProxyServer({ silent: true, profiles: [profile], defaultProfile: profile.id })
    listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) })
    const healthResponse = await fetch(`http://127.0.0.1:${listener.port}/health`)
    const health = await healthResponse.json()
    const listResponse = await fetch(`http://127.0.0.1:${listener.port}/profiles/list`)
    const list = await listResponse.json(); const listed = list.profiles[0]
    assert.equal(healthResponse.status, 200); assert.equal(health.status, 'healthy')
    assert.equal(listResponse.status, 200)
    // Real CLI auth status only recognizes the supplied API key; this does
    // not validate that synthetic key for model inference.
    assert.equal(health.auth.loggedIn, true)
    const inheritedPlan = health.auth.allowance === '20x' && listed.allowance === '20x'
    const inheritedRenewal = health.auth.renewalRequiredSoon === true
    const demotedApiProfile = listed.loggedIn === false
    if (expectLeak) {
      assert(inheritedPlan && inheritedRenewal, 'Baseline native metadata leak not reproduced')
      assert.equal(demotedApiProfile, scenario === 'unrelated-empty-grant')
    } else {
      assert.equal(health.auth.allowance, null); assert.equal(listed.allowance, null)
      assert.equal(health.auth.rateLimitTier, null); assert.equal(listed.rateLimitTier, null)
      assert.equal(inheritedRenewal, false); assert.equal(demotedApiProfile, false)
    }
    cases.push({ scenario, healthStatus: healthResponse.status, realCliReportsApiLoggedIn: true,
      inheritedPlan, inheritedRenewal, demotedApiProfile })
    listener.stop(true); listener = undefined
  }
  assert.equal(defaultFallbacks > 0, expectLeak)
  assert.equal(nativeReads > 0, expectLeak)
  const executable = await models.resolveClaudeExecutableAsync()
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  console.log(JSON.stringify({ result: expectLeak ? 'REPRODUCED_METADATA_LEAK' : 'PASS', sourceHead,
    platform: `${process.platform}/${process.arch}`, bun: Bun.version, claude: version.stdout.trim(),
    nativeStore: process.platform === 'darwin' ? 'owned-Keychain' : 'owned-file', defaultStoreRedirected: true,
    hostCredentialsRead: false, modelCalls: false, defaultFallbacks, nativeReads, cases }))
  if (servePort !== undefined) {
    const { app } = createProxyServer({ silent: true, profiles: [{ id: 'owned-api-fixture', type: 'api',
      apiKey: 'owned-synthetic-api-key-not-valid-for-inference' }], defaultProfile: 'owned-api-fixture' })
    listener = Bun.serve({ hostname: '127.0.0.1', port: servePort, fetch: request => {
      if (/^\/(v1|v2)\//.test(new URL(request.url).pathname)) return new Response('Model calls forbidden in this fixture', { status: 403 })
      return app.fetch(request)
    } })
    console.log(JSON.stringify({ fixture: 'owned-api-metadata', port: listener.port, secrets: false }))
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done) })
  }
} finally {
  listener?.stop(true); factorySpy.mockRestore(); sdkSpy.mockRestore()
  if (itemWritten && process.platform === 'darwin') {
    const deleted = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', nativeService, '-a', userInfo().username], { encoding: 'utf8' })
    assert.equal(deleted.status, 0, 'Cannot remove the fixture-only Keychain item')
  }
  rmSync(root, { recursive: true, force: true })
}
