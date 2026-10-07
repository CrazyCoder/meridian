// Opt-in: rebuilds this checkout three times, without restarting any service.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const fixtureRoot = mkdtempSync(join(tmpdir(), "meridian-provenance-e2e-"))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
process.env.MERIDIAN_CONFIG_DIR = join(fixtureRoot, "config")
process.env.MERIDIAN_SESSION_DIR = join(fixtureRoot, "sessions")
process.env.CLAUDE_CONFIG_DIR = join(fixtureRoot, "credentials")
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { mode: 0o700 })
process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
delete process.env.MERIDIAN_API_KEY
const require = createRequire(import.meta.url)
const { serve } = require("@hono/node-server")
const { createProxyServer } = await import("../dist/server.js")
const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles: [{ id: "build-verification", claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }] })
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
await once(server, "listening")
const url = "http://127.0.0.1:" + server.address().port

async function status() {
  const response = await fetch(new URL("/build-status", url))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  return response.json()
}

async function waitFor(predicate) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const result = await status()
    if (predicate(result)) return result
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error("Build status did not reach the expected state")
}

try {
  const initial = await waitFor(result => result.state === "current")
  assert.equal(initial.runtime.certification, "verified")
  assert.equal(initial.runtime.counter, initial.latest.counter)
  console.log(JSON.stringify({ phase: "current", counter: initial.runtime.counter, identity: initial.runtime.displayVersion }))
  for (let n = 0; n < 3; n++) {
    const child = spawn("bun", ["scripts/build.ts"], { cwd: root, env: { ...process.env }, stdio: "inherit" })
    const [code] = await once(child, "exit")
    assert.equal(code, 0, "actual rebuild passed")
  }
  const behind = await waitFor(result => result.buildsBehind === 3)
  assert.equal(behind.state, "behind")
  assert.deepEqual(behind.runtime, initial.runtime)
  const responses = await Promise.all(Array.from({ length: 30 }, () => fetch(new URL("/build-status", url))))
  assert.ok(responses.every(response => response.status === 200))
  console.log(JSON.stringify({ phase: "behind", runtimeCounter: behind.runtime.counter, diskCounter: behind.latest.counter,
    buildsBehind: behind.buildsBehind, runtimeImmutable: true, concurrentRequests: responses.length }))
} finally {
  server.close()
  rmSync(fixtureRoot, { recursive: true, force: true })
}
process.exit(0)
