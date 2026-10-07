#!/usr/bin/env bun
// Synthetic turn locks only: fault-inject unreadable metadata while a real
// holder is alive but SIGSTOPed. No SDK persistence or customer state is used.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const modulePath = resolve(process.env.E2E_TURN_COORDINATOR_MODULE ?? 'src/proxy/session/crossProcessTurnCoordinator.ts')
const { CrossProcessTurnCoordinator } = await import(pathToFileURL(modulePath).href)
const options = { acquireTimeoutMs: 500, staleAfterMs: 100, heartbeatIntervalMs: 25,
  retryDelayMs: 10, ownerlessGraceMs: 200, bootTimeMs: () => Date.now() - 3_600_000 }
const key = 'synthetic-paused-owner'
if (process.argv.includes('--holder')) {
  const root = process.argv.at(-1)
  await new CrossProcessTurnCoordinator(root, options).acquire(key)
  console.log('READY')
  setInterval(() => undefined, 1000)
} else {
  assert(process.platform !== 'win32', 'SIGSTOP review requires a POSIX host')
  const root = await mkdtemp(join(tmpdir(), 'meridian-ownerless-review-'))
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--holder', root],
    { env: { ...process.env, E2E_TURN_COORDINATOR_MODULE: modulePath }, stdio: ['ignore', 'pipe', 'pipe'] })
  let lease
  let readinessTimer
  const exited = new Promise(resolve => child.once('close', resolve))
  try {
    try {
      await Promise.race([
      new Promise((resolveReady, reject) => {
        child.stdout.on('data', data => { if (String(data).includes('READY')) resolveReady() })
        child.once('error', reject)
        child.once('exit', () => reject(new Error('holder exited before readiness')))
      }),
      new Promise((_, reject) => { readinessTimer = setTimeout(() => reject(new Error('holder readiness timed out')), 3000) }),
      ])
    } finally {
      clearTimeout(readinessTimer)
    }
    assert(child.pid)
    child.kill('SIGSTOP')
    await new Promise(resolve => setTimeout(resolve, 30))
    const stopped = spawnSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8' })
    assert.equal(stopped.status, 0)
    assert(stopped.stdout.includes('T'), 'kernel did not confirm stopped holder')
    const lock = join(root, createHash('sha256').update(key).digest('hex') + '.lock')
    await writeFile(join(lock, 'owner.json'), '\0'.repeat(338))
    const age = new Date(Date.now() - 3000)
    for (const name of await readdir(lock)) await utimes(join(lock, name), age, age)
    await utimes(lock, age, age)
    let refusal
    try { lease = await new CrossProcessTurnCoordinator(root, options).acquire(key) }
    catch (error) { refusal = error instanceof Error ? error.name : 'unknown' }
    process.kill(child.pid, 0)
    const acquired = !!lease
    console.log(JSON.stringify({ platform: process.platform, ownerAlive: true, kernelStopped: true,
      corruptedOwner: true, staleHeartbeats: true, contenderAcquired: acquired, refusal: refusal ?? null }))
    if (process.argv.includes('--expect-refusal')) assert.equal(acquired, false)
    if (process.argv.includes('--expect-acquisition')) assert.equal(acquired, true)
  } finally {
    child.kill('SIGKILL')
    await exited
    await lease?.release()
    await rm(root, { recursive: true, force: true })
  }
}
