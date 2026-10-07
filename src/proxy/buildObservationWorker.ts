import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { readCertifiedBuild } from "./buildArtifacts"
import { snapshotSource, BuildProvenanceError } from "./buildSnapshot"

const input = z.object({ root: z.string(), kind: z.enum(["source", "artifact"]).optional() }).parse(workerData)
try {
  const latest = input.kind === "source"
    ? { ...snapshotSource(input.root), source: "local", kind: "source" }
    : readCertifiedBuild(input.root).build
  parentPort?.postMessage({ latest, state: "unknown" })
} catch (error) {
  if (!(error instanceof Error)) throw error
  const state = error instanceof BuildProvenanceError && error.reason === "building" ? "building"
    : "code" in error && error.code === "ENOENT" ? "missing" : "invalid"
  parentPort?.postMessage({ state })
}
