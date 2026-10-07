import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { BuildProvenanceError } from "./buildSnapshot"

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    return true
  }
}

export function buildBusy(store: string, own?: string): boolean {
  return readdirSync(store).some(name => {
    const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(name)
    return name !== own && (name === "lock" || (!!match && alive(Number(match[1]))))
  })
}

export function acquireBuildLock(store: string): () => void {
  mkdirSync(store, { recursive: true })
  const own = `owner-${process.pid}-${randomUUID()}`
  mkdirSync(join(store, own))
  const release = () => rmSync(join(store, own), { recursive: true, force: true })
  const deadline = Date.now() + 2000
  try {
    while (buildBusy(store, own)) {
      if (Date.now() >= deadline) throw new BuildProvenanceError("building")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    for (const name of readdirSync(store)) {
      const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(name)
      if (match && !alive(Number(match[1]))) rmSync(join(store, name), { recursive: true, force: true })
    }
    return release
  } catch (error) { release(); throw error }
}
