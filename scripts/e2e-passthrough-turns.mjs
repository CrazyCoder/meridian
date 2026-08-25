#!/usr/bin/env bun
/**
 * Multi-turn passthrough conversation through the REAL proxy.
 *
 * probe-passthrough-accumulation.mjs proves the defect and the repair at the
 * SDK level. This drives Meridian itself the way OpenCode does: send a
 * request with tools, execute the tool_use blocks it returns, replay the
 * whole history plus tool_results as the next request, repeat until the
 * model answers in text. The proxy strips ANTHROPIC_BASE_URL from the SDK
 * subprocess, so the wire is not observable here; the verdict rests on two
 * things that are:
 *
 *   - the model's final answer quotes every file it was handed, and it never
 *     says a call went unanswered
 *   - the session JSONL holds no forwarded denial for an id whose real result
 *     was delivered
 *
 * Run it against the fix and it passes; stash src/proxy/server.ts and it
 * fails on both counts by the third turn.
 *
 *   bun scripts/e2e-passthrough-turns.mjs [--stream]
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotSessionFiles as snapshot, readRows, blocksOf } from "./lib/passthrough-jsonl.mjs"
import { isForwardedDenial } from "../src/proxy/passthroughTranscript.ts"

process.env.MERIDIAN_PASSTHROUGH = "1"
process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = "1"
const { startProxyServer } = await import("../src/proxy/server.ts")

const STREAM = process.argv.includes("--stream")
const PORT = Number(process.env.PROBE_PORT ?? 3522)
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5"
const MAX_TURNS = Number(process.env.PROBE_TURNS ?? 6)

const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-probe-proxy-"))
const CONTENT = { "a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie" }
const FILES = Object.keys(CONTENT).map(f => join(WORKDIR, f))
for (const f of FILES) writeFileSync(f, CONTENT[f.slice(-5)] + "\n")

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
    required: ["file_path"],
  },
}

// The proxy logs on stdout and stderr; keep both out of the probe's own
// output and readable for the per-turn repair line.
const say = console.log.bind(console)
const proxyLog = []
for (const k of ["log", "error"]) console[k] = (...args) => { proxyLog.push(args.map(String).join(" ")) }
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1" })
const short = s => (typeof s === "string" && s.length > 10 ? s.slice(-8) : String(s))

/** Parse either response shape into assistant content blocks. */
async function assistantBlocks(res) {
  const text = await res.text()
  if (!STREAM) return JSON.parse(text).content ?? []
  const blocks = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    let ev
    try { ev = JSON.parse(line.slice(5)) } catch { continue }
    if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block, ...(ev.content_block.type === "tool_use" ? { _json: "" } : {}) }
    if (ev.type === "content_block_delta") {
      const b = blocks[ev.index]
      if (ev.delta.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text
      if (ev.delta.type === "input_json_delta") b._json += ev.delta.partial_json
    }
  }
  return blocks.filter(Boolean).map(b => {
    if (b.type === "tool_use") { const { _json, ...rest } = b; return { ...rest, input: _json ? JSON.parse(_json) : (b.input ?? {}) } }
    return b
  })
}

const sessionId = `probe-turns-${STREAM ? "stream" : "nonstream"}-${process.pid}`
const messages = [{
  role: "user",
  content:
    `Use the read tool to read ${FILES[0]}. Only after its content has been returned to you, ` +
    `read ${FILES[1]}. Only after that content has been returned, read ${FILES[2]}. ` +
    `Make exactly one read call per step, never in parallel, and once you have all three ` +
    `reply with the three contents on one line and nothing else.`,
}]

const before = snapshot()
const delivered = new Set()
let finalText = ""

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const logFrom = proxyLog.length
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "x-opencode-session": sessionId, "user-agent": "opencode/1.0.0" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: STREAM, tools: [READ_TOOL], messages }),
  })
  const blocks = await assistantBlocks(res)
  const calls = blocks.filter(b => b.type === "tool_use")
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("")
  const repaired = proxyLog.slice(logFrom).filter(l => l.includes("denials_rewritten"))
  say(`\n=== turn ${turn} (stream=${STREAM}) http ${res.status} ===`)
  say(`  calls: ${calls.map(c => `${c.name}(${String(c.input?.file_path ?? "").slice(-5)})#${short(c.id)}`).join(", ") || "none"}`)
  if (text) say(`  text: ${JSON.stringify(text.slice(0, 200))}`)
  say(`  proxy repair log: ${repaired.length ? repaired.map(l => l.replace(/^.*denials_rewritten/, "denials_rewritten").slice(0, 160)).join(" | ") : "none"}`)
  if (res.status !== 200) { say(`  body: ${JSON.stringify(blocks).slice(0, 300)}`); break }

  messages.push({ role: "assistant", content: blocks.map(({ type, id, name, input, text }) => type === "tool_use" ? { type, id, name, input } : { type, text }) })
  if (calls.length === 0) { finalText = text; break }

  // Execute the forwarded calls like a client would.
  const results = calls.map(c => {
    const p = String(c.input?.file_path ?? "")
    let content
    try { content = readFileSync(p, "utf8").trim() } catch (e) { content = `ERROR: ${e.message}` }
    delivered.add(c.id)
    return { type: "tool_result", tool_use_id: c.id, content: `REALOUTPUT[${content}]` }
  })
  messages.push({ role: "user", content: results })
}

// The CLI flushes the transcript as the query settles; give it a beat.
await new Promise(r => setTimeout(r, 1500))
const touched = [...snapshot().entries()].filter(([p, m]) => !before.has(p) || before.get(p) !== m).map(([p]) => p)

say(`\n=== verdict (stream=${STREAM}) ===`)
const quotes = Object.values(CONTENT).filter(w => finalText.includes(w))
const claimsUnanswered = /forwarded|no content|not returned|never returned|no result/i.test(finalText)
say(`  turns used: ${messages.filter(m => m.role === "assistant").length}, calls delivered: ${delivered.size}`)
say(`  final reply quotes ${quotes.length}/3 contents: ${quotes.join(",") || "none"}${claimsUnanswered ? "   <-- and claims a call went unanswered" : ""}`)
let staleDenials = 0
for (const f of touched) {
  const denials = readRows(f).flatMap(r => blocksOf(r).filter(b => isForwardedDenial(b) && delivered.has(b.tool_use_id)))
  staleDenials += denials.length
  say(`  ${f}\n    forwarded denials still stored for delivered ids: ${denials.length}${denials.length ? "   <-- REPLAYED ON THE NEXT RESUME" : "   (clean)"}`)
}
if (touched.length === 0) say("  no session JSONL was written — inconclusive")
const pass = quotes.length === 3 && !claimsUnanswered && staleDenials === 0 && touched.length > 0
say(`  ${pass ? "PASS" : "FAIL"}: one call, one answer, the real one`)

await inst.stop?.()
process.exit(pass ? 0 : 1)
