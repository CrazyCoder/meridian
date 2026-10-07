import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotSource } from "../proxy/buildSnapshot"
import { readProvenanceText } from "../proxy/buildFingerprint"
import { artifactInventory } from "../proxy/buildArtifacts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-provenance-budget-"))); roots.push(root)
  expect(spawnSync("git", ["init", root]).status).toBe(0)
  writeFileSync(join(root, "package.json"), '{"version":"1.79.0"}')
  expect(spawnSync("git", ["-C", root, "add", "package.json"]).status).toBe(0)
  expect(spawnSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]).status).toBe(0)
  return root
}
function oversized(path: string): void { const fd=openSync(path,"w");closeSync(fd);truncateSync(path,65*1024*1024) }
test("source provenance refuses an oversized untracked input instead of hashing an unbounded allocation", () => {
  const root=fixture();oversized(join(root,"oversized.bin"))
  expect(()=>snapshotSource(root)).toThrow("Build provenance unavailable")
})
test("artifact startup verification refuses oversized disk output", () => {
  const root=fixture(),dist=join(root,"dist");mkdirSync(dist);oversized(join(dist,"oversized.bin"))
  expect(()=>artifactInventory(dist)).toThrow("Build provenance unavailable")
})

test("an alias of the exact repository root retains provenance while nested parent adoption stays refused", () => {
  const root=fixture(),alias=root+"-alias"
  symlinkSync(root,alias,process.platform==="win32"?"junction":"dir");roots.push(alias)
  expect(snapshotSource(alias).sourceHash).toBe(snapshotSource(root).sourceHash)
  mkdirSync(join(root,"nested"))
  expect(()=>snapshotSource(join(root,"nested"))).toThrow("Build provenance unavailable")
})

test("metadata read caps apply before allocating and parsing oversized JSON", () => {
  const root=fixture(),path=join(root,"manifest.json");oversized(path)
  expect(()=>readProvenanceText(path)).toThrow("Build provenance unavailable")
  writeFileSync(path,'{"value":"café/你好"}')
  expect(readProvenanceText(path)).toBe('{"value":"café/你好"}')
})
