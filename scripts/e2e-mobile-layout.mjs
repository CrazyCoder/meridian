#!/usr/bin/env bun
// Real page templates, synthetic account data, no credentials or model calls.
// E2E_BASELINE_ROOT=<unchanged checkout> bun scripts/e2e-mobile-layout.mjs
// Open /after/ and /after/profiles in the collaborative browser. /before/*
// loads the identical fixture through baseline templates for negative controls.
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const trees = { after: root, before: process.env.E2E_BASELINE_ROOT ?? root }
const pages = {}
for (const [label, tree] of Object.entries(trees)) {
  pages[label] = {
    home: (await import(pathToFileURL(join(tree, 'src/telemetry/landing.ts')).href)).landingHtml,
    profiles: (await import(pathToFileURL(join(tree, 'src/telemetry/profilePage.ts')).href)).profilePageHtml,
  }
}
const ids = ['personal-account-with-a-long-name@example.invalid', 'work-account-with-a-long-name@example.invalid', 'needs-login-account@example.invalid']
const profiles = ids.map((id, i) => ({ id, type: 'claude-max', isActive: i === 0, loggedIn: i !== 2,
  email: 'very-long-synthetic-address-for-layout-verification@example.invalid',
  organizationName: 'AnUnbrokenSyntheticOrganizationNameForWrappingVerification', allowance: '20x', planLabel: 'Max',
  authMethod: 'claude.ai', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }))
const roster = { profiles, activeProfile: ids[0], routing: 'active+priority', profileOrder: ids,
  exhausted: [{ id: ids[1], reason: 'billing_error', until: Date.now()+600000 }],
  follow: { url: 'http://fixture.invalid:3456', activeProfile: ids[0] } }
const quota = { profiles: profiles.map((p, i) => ({ id: p.id, windows: [
  { type: 'five_hour', utilization: .67, resetsAt: Date.now()+3600000 },
  { type: 'seven_day', utilization: .90, resetsAt: Date.now()+86400000 }],
  ...(i === 1 ? { spent: { until: Date.now()+600000, diagnosis: { bucket: 'five_hour', reported: true, rationale: 'Synthetic refusal' } } } : {}) })) }
const health = { status: 'healthy', backend: 'claude', model: 'claude-opus-5-5', auth: { loggedIn: true },
  build: { source: 'npm', version: '1.79.0', latest: '1.79.1', updateAvailable: true } }
const summary = { totalRequests: 10, requests: 10, errors: 0, costEstimate: { byProfile: Object.fromEntries(ids.map(id => [id, { requests: 10, estimatedUsd: 1234.56 }])) } }
const { iconResponse } = await import('../src/telemetry/icon.ts')
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid')
  const match = url.pathname.match(/^\/(after|before)(\/profiles)?\/?$/)
  if (match) { res.setHeader('Content-Type', 'text/html'); res.end(pages[match[1]][match[2] ? 'profiles' : 'home']); return }
  if (url.pathname === '/telemetry/icon.svg') {
    const icon = iconResponse(); res.statusCode = icon?.status ?? 404
    if (icon) { res.setHeader('Content-Type', icon.headers.get('content-type')); res.end(await icon.text()) } else res.end()
    return
  }
  const data = url.pathname === '/health' ? health : url.pathname === '/profiles/list' ? roster
    : url.pathname === '/v1/usage/quota/all' ? quota : url.pathname === '/telemetry/summary' ? summary
    : url.pathname === '/settings/api/routing' ? { routing: 'active+priority', profileOrder: ids } : null
  res.statusCode = data ? 200 : 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data))
})
server.listen(Number(process.env.E2E_PORT ?? 42098), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/after/`, baseline: resolve(trees.before), fixture: 'synthetic only' })))
