import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { signalAgProcess } from './antigravityProcess'

type Probe = 'version' | 'configuration' | 'models'
type Failure = 'timeout' | 'cancelled' | 'spawn' | 'exit' | 'output-limit'
interface ProbeOptions {
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  // Internal test deadlines; the runtime uses the defaults, not client controls.
  timeoutMs?: number
  killGraceMs?: number
}
export class ProbeFailure extends Error {
  constructor(readonly reason: Failure, message: string) { super(message) }
}

/** Read-only official commands only. Never retry model generation or print CLI output. */
export async function readAgProbe(executable: string, kind: Probe, options: ProbeOptions): Promise<string> {
  const attempts = kind === 'version' ? 1 : 2
  for (let attempt = 1; ; attempt++) {
    try { return await probeOnce(executable, kind, options, attempt) }
    catch (error) {
      if (!(error instanceof ProbeFailure) || error.reason !== 'timeout' || attempt >= attempts || options.signal.aborted) throw error
      console.warn(`[antigravity] ${error.message}; retrying the read-only ${kind === 'models' ? 'model discovery' : 'configuration check'} once`)
      await delay(250, undefined, { signal: options.signal })
    }
  }
}

function probeOnce(executable: string, kind: Probe, options: ProbeOptions, attempt: number): Promise<string> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 20_000
  if (options.signal.aborted) return Promise.reject(new ProbeFailure('cancelled', 'Antigravity account check cancelled; no model request was sent'))
  return new Promise((resolve, reject) => {
    const args = kind === 'version' ? ['--version'] : kind === 'models' ? ['models'] : ['-p', '/config', '--output-format', 'json']
    const child = spawn(executable, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    let failure: Failure | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let bytes = 0
    const output: Buffer[] = []
    const stop = (reason: Failure) => {
      if (failure) return
      failure = reason
      signalAgProcess(child, 'SIGTERM')
      killTimer = setTimeout(() => signalAgProcess(child, 'SIGKILL'), options.killGraceMs ?? 1000)
      killTimer.unref()
    }
    const cancel = () => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref()
    options.signal.addEventListener('abort', cancel, { once: true })
    if (options.signal.aborted) cancel()
    const read = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) { stop('output-limit'); return }
      if (stdout) output.push(chunk)
    }
    child.stdout.on('data', chunk => read(Buffer.from(chunk), true))
    child.stderr.on('data', chunk => read(Buffer.from(chunk), false))
    child.stdin.on('error', () => stop('exit'))
    child.stdin.end()
    child.once('error', () => { failure ??= 'spawn' })
    // close joins exit and stdio. A timed-out probe cannot overlap its retry.
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer)
      options.signal.removeEventListener('abort', cancel)
      if (failure || code !== 0) {
        const reason = failure ?? 'exit'
        reject(new ProbeFailure(reason, `Antigravity ${kind === 'version' ? 'version' : kind === 'models' ? 'model discovery' : 'subscription configuration'} check failed (reason=${reason}, attempt=${attempt}, elapsedMs=${Date.now() - started}, deadlineMs=${timeoutMs}, exit=${code}, signal=${signal}, outputBytes=${bytes}); no model request was sent`))
      } else resolve(Buffer.concat(output).toString('utf8'))
    })
  })
}
