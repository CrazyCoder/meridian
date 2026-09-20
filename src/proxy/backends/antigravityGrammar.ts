import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import type { AgRequest } from './antigravityProtocol'
import { AntigravityError } from './antigravityProtocol'

const regexWorker = `const { parentPort, workerData } = require('node:worker_threads');try {const expression=new RegExp('^(?:'+workerData.definition+')$','u');const match=workerData.value===undefined?true:expression.exec(workerData.value);parentPort.postMessage({ok:workerData.value===undefined||!!match&&match[0].length===workerData.value.length});} catch(error){parentPort.postMessage({error:String(error)});}`
const larkScript = `import sys,json
from lark import Lark
x=json.load(sys.stdin)
p=Lark(x['definition'],parser='earley',start='start')
if 'value' in x: p.parse(x['value'])
print('OK')
`
/** Validate custom tool payloads outside the server thread with a hard deadline. */
export class AgGrammars {
  constructor(private readonly request: AgRequest, private readonly signal: AbortSignal) {}
  async prepare() {
    try { for (const grammar of Object.values(this.request.meridian_tool_grammars ?? {})) await this.check(grammar) }
    catch (error) { if (error instanceof AntigravityError) throw error; throw new AntigravityError('Invalid custom grammar: ' + String(error)) }
  }
  async validate(name: string, input: Record<string, unknown>) {
    const grammar = this.request.meridian_tool_grammars?.[name]
    if (!grammar) return
    if (typeof input.input !== 'string') throw new AntigravityError('Custom tool input must be a string')
    await this.check(grammar, input.input)
  }
  private async check(grammar: { syntax: 'regex' | 'lark'; definition: string }, value?: string): Promise<void> {
    const release = await grammarSlot(this.signal)
    try { await this.checkInside(grammar, value) } finally { release() }
  }
  private async checkInside(grammar: { syntax: 'regex' | 'lark'; definition: string }, value?: string): Promise<void> {
    if (this.signal.aborted) throw new AntigravityError('Grammar validation cancelled', 499)
    if (grammar.syntax === 'regex') {
      const worker = new Worker(regexWorker, { eval: true, workerData: { definition: grammar.definition, value } })
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Regex validation exceeded two seconds')), 2000)
          abort = () => reject(new Error('Grammar validation cancelled'))
          this.signal.addEventListener('abort', abort, { once: true })
          worker.once('error', reject)
          worker.once('exit', code => { if (code !== 0) reject(new Error('Grammar worker exited')) })
          worker.once('message', (result: { ok?: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error ?? 'Custom tool input violates its regex grammar')))
        })
      } finally { clearTimeout(timer); if (abort) this.signal.removeEventListener('abort', abort); await worker.terminate() }
      return
    }
    // Only the bundled common grammar may be imported. Do not let a client read
    // arbitrary host .lark files through grammar import resolution.
    for (const line of grammar.definition.split('\n')) if (line.includes('%import') && !/^\s*%import\s+common\.[A-Za-z_][A-Za-z_0-9]*(?:\s*->\s*[A-Za-z_][A-Za-z_0-9]*)?\s*$/.test(line)) throw new AntigravityError('Lark imports are limited to individual common rules')
    const executable = process.env.MERIDIAN_AGY_GRAMMAR_PYTHON
    if (!executable) throw new AntigravityError('Lark custom tools require MERIDIAN_AGY_GRAMMAR_PYTHON pointing to a Python installation with lark')
    const child = spawn(executable, ['-I', '-c', larkScript], { stdio: ['pipe', 'pipe', 'pipe'], signal: this.signal })
    let stderr = '', timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Lark validation exceeded five seconds')) }, 5000)
        child.on('error', reject); child.stdin.on('error', reject)
        child.stdout.resume()
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
        child.once('close', code => code === 0 ? resolve() : reject(new AntigravityError('Invalid Lark grammar/input or missing local lark dependency: ' + stderr)))
        child.stdin.end(JSON.stringify({ definition: grammar.definition, ...(value === undefined ? {} : { value }) }))
      })
    } finally { clearTimeout(timer); child.kill('SIGKILL') }
  }
}

let grammarWorkers = 0
const grammarQueue: Array<() => void> = []
async function grammarSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw new AntigravityError('Grammar validation cancelled', 499)
  if (grammarWorkers >= 8) {
    if (grammarQueue.length >= 64) throw new AntigravityError('Grammar validation capacity is full', 429)
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); grammarWorkers++; resolve() }
      const abort = () => { const index = grammarQueue.indexOf(ready); if (index >= 0) grammarQueue.splice(index, 1); reject(new AntigravityError('Grammar validation cancelled', 499)) }
      grammarQueue.push(ready); signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } else grammarWorkers++
  return () => { grammarWorkers--; grammarQueue.shift()?.() }
}
