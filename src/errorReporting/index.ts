/**
 * Opt-in reporting of Meridian's own uncaught exceptions and unhandled promise
 * rejections to a Sentry-protocol collector (GlitchTip, Sentry). Errors only:
 * no tracing, no profiling, no breadcrumbs, no request data.
 *
 * OFF UNLESS A DSN IS CONFIGURED. `MERIDIAN_ERROR_REPORTING_DSN`, else
 * `errorReportingDsn` in settings.json. With neither, `installErrorReporter`
 * attaches nothing, writes nothing and opens no connection.
 *
 * IT MUST NEVER CHANGE WHETHER THE PROCESS DIES. `uncaughtExceptionMonitor`
 * observes an uncaught exception without handling it: the Meridian CLI's own
 * recovering handler still recovers, and a process without one still crashes.
 * `unhandledRejection` is different: ANY listener suppresses the runtime's
 * default behavior. With no other listener it honors Node's rejection policy:
 * fatal modes rethrow, warning/none modes survive, and warn-with-error-code
 * retains exit code 1. CLI options override NODE_OPTIONS. When
 * somebody else also listens (the CLI does) it records and leaves the decision
 * to them. The rethrow reaches the monitor, which recognises it and does not
 * record it twice.
 *
 * IT MUST NEVER THROW OR BLOCK. Recording is one synchronous write of a
 * ready-to-post envelope into a private spool directory, because the exception
 * that matters most is the one that kills the process and nothing asynchronous
 * finishes inside that hook. A process that survives the error delivers it
 * from an unref'd timer; one that is dying starts a detached delivery child
 * (see deliver.ts) and never waits for it. Whatever is left - a collector
 * that was down - is delivered on the next start. Everything is inside a
 * catch, because a reporter that throws from an error hook replaces the real
 * error with its own.
 */

import { nodeRejectionPolicy } from "./rejectionPolicy"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { configPath } from "../configDir"
import { getSetting } from "../settings"
import { deliverSpool, type DeliveryJob, type FlushSummary } from "./deliver"
import { authHeader, buildEnvelope, buildEvent, parseDsn, type Mechanism } from "./event"

export type { FlushSummary }

export const REPORTER_CLIENT = "meridian-error-reporter/1"
/** An error loop must not become a spool loop. */
export const MAX_EVENTS_PER_MINUTE = 30
/** Past this many queued events, new ones are dropped rather than filling the disk. */
export const MAX_SPOOLED = 500
/** Startup delivery waits a little, so it never competes with binding the listener. */
const STARTUP_FLUSH_DELAY_MS = 5_000
export const DETACHED_FLUSH_JOB_ENV = "MERIDIAN_ERROR_REPORTING_FLUSH_JOB"
const STATE = Symbol.for("meridian.error-reporter")

export interface ErrorReporterOptions {
  /** Meridian version, sent as the `meridian@<version>` release. */
  readonly version?: string
  /** Override configuration resolution and timing. Tests only. */
  readonly dsn?: string
  readonly spoolDir?: string
  readonly startupFlushDelayMs?: number
}

interface ReporterState {
  readonly job: DeliveryJob
  readonly release?: string
  /** The rejection this module is rethrowing, boxed so `undefined` reasons still match. */
  rethrowing: { readonly value: unknown } | undefined
  strictRejectionObserved: boolean
  windowStart: number
  windowCount: number
  flushing: boolean
  flushAgain: boolean
}

/**
 * The configured DSN, or undefined when reporting is off.
 *
 * NOTE: read straight from process.env rather than through env.ts, which would
 * also accept a CLAUDE_PROXY_ alias. The variable postdates that prefix (the
 * configDir.ts precedent). A non-empty environment value wins over settings.json.
 */
export function resolveErrorReportingDsn(): string | undefined {
  const fromEnv = process.env.MERIDIAN_ERROR_REPORTING_DSN?.trim()
  if (fromEnv) return fromEnv
  const fromSettings = getSetting("errorReportingDsn")
  return typeof fromSettings === "string" && fromSettings.trim() !== "" ? fromSettings.trim() : undefined
}

export function defaultSpoolDir(): string {
  return configPath("error-reports")
}

/**
 * Meridian's package root: the nearest directory above this module with a
 * package.json. Frames under it are in-app. Resolved from the module's own
 * location so it is right for a source checkout, the bundled dist/ and an npm
 * install alike.
 */
function findPackageRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

function runtimeInfo(): { name: string; version: string } {
  const bun = (process.versions as Record<string, string | undefined>).bun
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node }
}

function stateSlot(): { [STATE]?: ReporterState } {
  return globalThis as { [STATE]?: ReporterState }
}

function spoolCount(dir: string): number {
  try {
    return fs.readdirSync(dir).length
  } catch {
    return 0
  }
}

/** One `0600` file per envelope in a `0700` directory. Synchronous by design. */
function spoolEnvelope(dir: string, eventId: string, envelope: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (spoolCount(dir) >= MAX_SPOOLED) return false
  const name = `${Date.now().toString(36).padStart(9, "0")}-${eventId}.json`
  const temporary = join(dir, `.${name}.tmp`)
  fs.writeFileSync(temporary, envelope, { mode: 0o600 })
  fs.renameSync(temporary, join(dir, name))
  return true
}

/** Deliver everything spooled in `dir` to `dsn` from this process. */
export function flushSpool(dir: string, dsn: string): Promise<FlushSummary> {
  const parsed = parseDsn(dsn)
  if (parsed === null) return Promise.resolve({ delivered: 0, rejected: 0, retained: spoolCount(dir) })
  return deliverSpool(fs, { dir, envelopeUrl: parsed.envelopeUrl, auth: authHeader(parsed.publicKey, REPORTER_CLIENT) })
}

function scheduleFlush(state: ReporterState, delayMs: number): void {
  if (state.flushing) {
    state.flushAgain = true
    return
  }
  state.flushing = true
  const timer = setTimeout(() => {
    void deliverSpool(fs, state.job)
      .catch(() => undefined)
      .finally(() => {
        state.flushing = false
        if (state.flushAgain) {
          state.flushAgain = false
          scheduleFlush(state, 0)
        }
      })
  }, delayMs)
  timer.unref?.()
}

/** The `-e` program of the detached delivery child; it reads its job from `DETACHED_FLUSH_JOB_ENV`. */
export function detachedFlushSource(): string {
  return `const fs = require("node:fs");(${deliverSpool.toString()})(fs, JSON.parse(process.env.${DETACHED_FLUSH_JOB_ENV})).catch(() => undefined).finally(() => process.exit(0))`
}

/**
 * Hand delivery to a detached child of the same runtime, which outlives this
 * dying process. Only a plain `node` or `bun` executable accepts `-e`; an
 * embedder running inside something else (Electron) leaves the event for the
 * next start instead.
 */
function spawnDetachedFlush(job: DeliveryJob): void {
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return
  const env: NodeJS.ProcessEnv = { ...process.env, [DETACHED_FLUSH_JOB_ENV]: JSON.stringify(job) }
  delete env.NODE_OPTIONS
  const child = spawn(process.execPath, ["-e", detachedFlushSource()], { detached: true, stdio: "ignore", windowsHide: true, env })
  child.on("error", () => undefined)
  child.unref()
}

function capture(state: ReporterState, thrown: unknown, mechanism: Mechanism, handled: boolean): void {
  try {
    const now = Date.now()
    if (now - state.windowStart >= 60_000) {
      state.windowStart = now
      state.windowCount = 0
    }
    if (++state.windowCount > MAX_EVENTS_PER_MINUTE) return
    const event = buildEvent({
      eventId: randomUUID().replaceAll("-", ""),
      timestampMs: now,
      thrown,
      mechanism,
      handled,
      packageRoot: findPackageRoot(),
      runtime: runtimeInfo(),
      release: state.release,
    })
    if (!spoolEnvelope(state.job.dir, event.event_id, buildEnvelope(event))) return
    if (handled) scheduleFlush(state, 0)
    else spawnDetachedFlush(state.job)
  } catch {
    // Reporting must never replace the error it is reporting.
  }
}

/**
 * Attach the process hooks once per process when a DSN is configured; later
 * calls are no-ops. Returns whether reporting is active. An unparseable DSN
 * leaves reporting off with one line on stderr that does not repeat the DSN.
 */
export function installErrorReporter(options: ErrorReporterOptions = {}): boolean {
  try {
    const slot = stateSlot()
    if (slot[STATE] !== undefined) return true
    const dsn = options.dsn ?? resolveErrorReportingDsn()
    if (dsn === undefined) return false
    const parsed = parseDsn(dsn)
    if (parsed === null) {
      console.error("[meridian] Error reporting disabled: the configured DSN is not a valid Sentry/GlitchTip DSN.")
      return false
    }
    const state: ReporterState = {
      job: {
        dir: options.spoolDir ?? defaultSpoolDir(),
        envelopeUrl: parsed.envelopeUrl,
        auth: authHeader(parsed.publicKey, REPORTER_CLIENT),
      },
      ...(options.version ? { release: `meridian@${options.version}` } : {}),
      rethrowing: undefined,
      strictRejectionObserved: false,
      windowStart: 0,
      windowCount: 0,
      flushing: false,
      flushAgain: false,
    }
    const policy = process.versions.bun ? "throw" : nodeRejectionPolicy(process.execArgv, process.env.NODE_OPTIONS)
    slot[STATE] = state
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      if (state.rethrowing !== undefined && error === state.rethrowing.value) {
        state.rethrowing = undefined
        return
      }
      if (policy === "strict" && origin === "unhandledRejection") {
        state.strictRejectionObserved = true
        queueMicrotask(() => { state.strictRejectionObserved = false })
      }
      const survives = process.listenerCount("uncaughtException") > 0
      capture(state, error, origin === "unhandledRejection" ? "onunhandledrejection" : "onuncaughtexception", survives)
    })
    process.on("unhandledRejection", (reason) => {
      if (state.strictRejectionObserved) { state.strictRejectionObserved = false; return }
      const sole = process.listenerCount("unhandledRejection") === 1
      const fatal = sole && (policy === "throw" || policy === "strict")
      capture(state, reason, "onunhandledrejection", !fatal)
      if (sole && policy === "warn-with-error-code") process.exitCode = 1
      if (fatal) {
        state.rethrowing = { value: reason }
        throw reason
      }
    })
    // Whatever an earlier crash or collector outage left behind.
    if (spoolCount(state.job.dir) > 0) scheduleFlush(state, options.startupFlushDelayMs ?? STARTUP_FLUSH_DELAY_MS)
    return true
  } catch {
    return false
  }
}
