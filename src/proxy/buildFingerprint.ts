import { createHash, type Hash } from "node:crypto"
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { BuildProvenanceError } from "./buildProvenanceError"

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 10_000

/** Full fingerprints only: exceeding any bound must never certify a prefix. */
export function fingerprintBudget() {
  const deadline = performance.now() + 2000
  let bytes = 0
  let entries = 0
  const check = () => {
    if (performance.now() >= deadline) throw new BuildProvenanceError("invalid")
  }
  return {
    check,
    remainingMs: () => { check(); return Math.max(1, Math.ceil(deadline - performance.now())) },
    entry: () => { check(); if (++entries > MAX_ENTRIES) throw new BuildProvenanceError("invalid") },
    file: (size: number) => {
      check()
      if (size > MAX_FILE_BYTES || bytes + size > MAX_TOTAL_BYTES) throw new BuildProvenanceError("invalid")
    },
    consume: (length: number) => {
      check(); bytes += length
      if (bytes > MAX_TOTAL_BYTES) throw new BuildProvenanceError("invalid")
    },
  }
}
export type FingerprintBudget = ReturnType<typeof fingerprintBudget>

export function hashFileInto(hash: Hash, path: string, budget: FingerprintBudget): void {
  const fd = openSync(path, "r")
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new BuildProvenanceError("invalid")
    budget.file(stat.size)
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let length = 0
    for (;;) {
      budget.check()
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (!read) break
      length += read
      if (length > MAX_FILE_BYTES) throw new BuildProvenanceError("invalid")
      budget.consume(read)
      hash.update(chunk.subarray(0, read))
    }
  } finally { closeSync(fd) }
}

export function fingerprintFile(path: string, budget: FingerprintBudget): string {
  const hash = createHash("sha256")
  hashFileInto(hash, path, budget)
  return hash.digest("hex")
}

/** Metadata has a separate small allocation cap before JSON/schema parsing. */
export function readProvenanceText(path: string, maximum = 4 * 1024 * 1024): string {
  const fd = openSync(path, "r")
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maximum) throw new BuildProvenanceError("invalid")
    const budget = fingerprintBudget()
    const chunk = Buffer.allocUnsafe(64 * 1024)
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      budget.check()
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (!read) break
      length += read
      if (length > maximum) throw new BuildProvenanceError("invalid")
      chunks.push(Buffer.from(chunk.subarray(0, read)))
    }
    return Buffer.concat(chunks, length).toString("utf8")
  } finally { closeSync(fd) }
}
