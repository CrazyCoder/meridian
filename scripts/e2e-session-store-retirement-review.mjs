#!/usr/bin/env bun
// Credentialless fault control for the proposed SQLite migration (#1243).
// Select the reviewed source module explicitly. Default expects safe retirement;
// E2E_EXPECT_RETIREMENT_RACE=1 records the source defect, never fix acceptance.
import assert from 'node:assert/strict'
import * as promises from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { spyOn } from 'bun:test'
assert(process.env.E2E_STORE_DATABASE_MODULE, 'Set E2E_STORE_DATABASE_MODULE to the reviewed storeDatabase.ts')
const modulePath = resolve(process.env.E2E_STORE_DATABASE_MODULE)
const git = spawnSync('git', ['-C', dirname(modulePath), 'rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(git.status, 0, 'Cannot determine reviewed source SHA')
const sourceHead = git.stdout.trim()
if (process.env.E2E_SOURCE_SHA) assert.equal(sourceHead, process.env.E2E_SOURCE_SHA)
const dir = mkdtempSync(join(tmpdir(), 'meridian-retirement-review-'))
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: dir, MERIDIAN_SESSION_DIR: join(dir, 'owned-sessions') })
const { fileDigest, retireImportedFile } = await import(pathToFileURL(modulePath).href)
const path = join(dir, 'sessions.json')
const imported = JSON.stringify({ imported: { claudeSessionId: 'already-in-db' } })
const replacement = JSON.stringify({ later: { claudeSessionId: 'not-in-db' } })
writeFileSync(path, imported, { mode: 0o600 })
const originalRename = promises.rename
let interleaved = false
const renameSpy = spyOn(promises, 'rename').mockImplementation(async (from, to) => {
  if (from === path && !interleaved) {
    // The old JSON writer publishes after the migration's digest read, before
    // the real retirement rename. These are real owned filesystem operations.
    const staging = join(dir, 'older-writer.tmp')
    writeFileSync(staging, replacement, { mode: 0o600 })
    renameSync(staging, path)
    interleaved = true
  }
  return originalRename(from, to)
})
try {
  const retired = await retireImportedFile(path, fileDigest(Buffer.from(imported)))
  const activeContainsReplacement = existsSync(path) && readFileSync(path, 'utf8') === replacement
  const retiredContainsUnimported = retired !== undefined && readFileSync(retired, 'utf8') === replacement
  const hazard = interleaved && !activeContainsReplacement && retiredContainsUnimported
  const expectHazard = process.env.E2E_EXPECT_RETIREMENT_RACE === '1'
  console.log(JSON.stringify({ result: hazard ? 'REPRODUCED_UNSAFE_RETIREMENT' : 'SAFE_RETIREMENT', sourceHead,
    platform: `${process.platform}/${process.arch}`, bun: Bun.version, interleaved, activeContainsReplacement,
    retiredContainsUnimported, expectedHazard: expectHazard, realFilesystem: true, modelCalls: false }))
  assert(interleaved, 'Fault control did not reach the retirement boundary')
  if (expectHazard) assert(hazard, 'Expected source defect was not reproduced')
  else assert(activeContainsReplacement && !retiredContainsUnimported, 'Retirement moved an unimported older-writer replacement away from the active path')
} finally {
  renameSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
}
