/**
 * Post every spooled error envelope to the collector, oldest first.
 *
 * SELF-CONTAINED ON PURPOSE. `deliverSpool` references nothing outside its own
 * body except globals present in every runtime Meridian runs on (`fetch`,
 * `AbortSignal`, `JSON`, `Date`, `process`), and receives the filesystem as an
 * argument. That lets the reporter hand it, as source text, to a detached
 * `node -e` / `bun -e` child when the error is killing the process: nothing
 * asynchronous finishes inside a dying process, and the child needs no separate
 * build entry to exist in a source checkout, the bundled dist/, Docker, Nix or
 * the desktop app alike. Adding an import or a module-level reference here
 * breaks that child silently; error-reporting.test.ts runs it for real.
 *
 * Each file is claimed by an atomic rename first, so two deliveries running at
 * once (a detached child and the next start's pass, or two Meridian processes
 * sharing a config directory) never post the same event. A 2xx is delivered;
 * a 4xx other than 429 will never be accepted (a deleted project, a revoked
 * key) and is dropped; anything else, including a refused connection, puts the
 * event back and ends the pass, because posting the rest of a backlog into a
 * collector that is not answering only adds load.
 */

export interface SpoolFs {
  readdirSync(path: string): string[]
  readFileSync(path: string, encoding: "utf8"): string
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { force: boolean }): void
  statSync(path: string): { mtimeMs: number }
}

export interface DeliveryJob {
  readonly dir: string
  readonly envelopeUrl: string
  readonly auth: string
}

export interface FlushSummary {
  readonly delivered: number
  readonly rejected: number
  readonly retained: number
}

export async function deliverSpool(fs: SpoolFs, job: DeliveryJob): Promise<FlushSummary> {
  const claimMarker = ".sending-"
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000
  const staleClaimMs = 5 * 60 * 1000
  const path = (name: string) => `${job.dir}/${name}`
  const list = (): string[] => {
    try {
      return fs.readdirSync(job.dir)
    } catch {
      return []
    }
  }
  const now = Date.now()
  for (const name of list()) {
    let mtime: number
    try {
      mtime = fs.statSync(path(name)).mtimeMs
    } catch {
      continue
    }
    if (now - mtime > maxAgeMs) fs.rmSync(path(name), { force: true })
    else if (name.includes(claimMarker) && now - mtime > staleClaimMs) {
      fs.renameSync(path(name), path(name.slice(0, name.lastIndexOf(claimMarker))))
    }
  }
  const names = list().filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()
  let delivered = 0
  let rejected = 0
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!
    const claimed = path(`${name}${claimMarker}${process.pid}`)
    try {
      fs.renameSync(path(name), claimed)
    } catch {
      continue
    }
    let body: string | undefined
    try {
      body = fs.readFileSync(claimed, "utf8")
    } catch {
      body = undefined
    }
    let outcome = "rejected"
    if (body !== undefined) {
      try {
        const response = await fetch(job.envelopeUrl, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": job.auth },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        await response.body?.cancel().catch(() => undefined)
        const status = response.status
        outcome = status >= 200 && status < 300
          ? "delivered"
          : status >= 400 && status < 500 && status !== 429 ? "rejected" : "retry"
      } catch {
        outcome = "retry"
      }
    }
    if (outcome === "retry") {
      fs.renameSync(claimed, path(name))
      return { delivered, rejected, retained: names.length - index }
    }
    fs.rmSync(claimed, { force: true })
    if (outcome === "delivered") delivered++
    else rejected++
  }
  return { delivered, rejected, retained: 0 }
}
