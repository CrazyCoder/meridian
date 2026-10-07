import { Worker } from "node:worker_threads"
import type { BuildInfo } from "./buildInfo"
import type { BuildState } from "./localBuildInfo"

export interface BuildObservation {
  readonly latest?: BuildInfo
  readonly state: BuildState
}

export function createBuildObserver(scan: () => Promise<BuildObservation>, cadence = 10_000, now = () => performance.now()) {
  let cached: BuildObservation = { state: "unknown" }
  let running = false
  let closed = false
  let lastStarted = -Infinity
  const refresh = async () => {
    if (running || closed) return
    running = true
    lastStarted = now()
    try { cached = await scan() }
    catch (error) {
      if (!(error instanceof Error)) throw error
      cached = { state: "unknown" }
    } finally { running = false }
  }
  return {
    read: () => {
      if (!running && !closed && now() - lastStarted >= cadence) void refresh()
      return cached
    },
    close: () => { closed = true },
  }
}

export function observeInWorker(root: string, kind: BuildInfo["kind"]): Promise<BuildObservation> {
  return new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const worker = new Worker(new URL(`./buildObservationWorker.${extension}`, import.meta.url), { workerData: { root, kind } })
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("Build observation deadline")) }, 5000)
    worker.once("message", (value: BuildObservation) => { clearTimeout(timeout); resolve(value) })
    worker.once("error", error => { clearTimeout(timeout); reject(error) })
    worker.once("exit", () => { clearTimeout(timeout); reject(new Error("Build observation exited before reporting")) })
    worker.unref()
  })
}
