// Manual native browser re-authentication through the compiled HTTP app.
// Use only an owned fixture root with profiles.json; never the host config.
// The public factory's separate startup refresh scheduler is deliberately absent.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
const root = realpathSync(process.env.E2E_EXISTING_ROOT)
const profileId = process.env.E2E_PROFILE_ID
assert(profileId, 'E2E_PROFILE_ID must identify the owned re-authentication profile')
const profiles = JSON.parse(readFileSync(join(root, 'config/profiles.json'), 'utf8'))
assert(profiles.some(profile => profile.id === profileId && profile.claudeConfigDir?.startsWith(root + '/')), 'Profile must use a credential directory inside the owned root')
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0', CLAUDE_CONFIG_DIR: join(root, 'unlinked-default') })
const { createProxyServer } = await import(pathToFileURL(resolve(process.env.E2E_SERVER_MODULE || 'dist/server.js')).href)
const { app } = createProxyServer({ silent: true, profiles, defaultProfile: profileId })
// Matches startProxyServer's bounded native Node ingress policy. The companion
// header-limit harness tests startProxyServer itself, including oversize refusal.
const server = serve({ fetch: app.fetch, serverOptions: { maxHeaderSize: 32 * 1024 },
  hostname: '127.0.0.1', port: Number(process.env.E2E_PORT || 42215), overrideGlobalObjects: false })
if (!server.listening) await once(server, 'listening')
console.log(JSON.stringify({ ready: true, port: server.address().port, node: process.version, profile: profileId, refreshScheduler: false }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)))
