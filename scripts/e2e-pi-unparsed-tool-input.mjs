#!/usr/bin/env bun
// Actual Pi + real SDK/CLI + local Anthropic API fixture. The fixture streams
// an edit call whose arguments hold a raw TAB inside a JSON string, a shape
// that fine-grained tool streaming lets through. The real CLI rejects it
// as unparseable before PreToolUse and reaches its one-turn cap. Pi must still
// receive the call, edit the file, and finish the follow-up turn.
// This is fault injection at the API boundary, not a live model claim.
//
//   bun scripts/e2e-pi-unparsed-tool-input.mjs            # corrected: exit 0
//   bun scripts/e2e-pi-unparsed-tool-input.mjs --expect-baseline
//
// E2E_PI_BIN selects the Pi executable (default: `pi` on PATH).
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const expectBaseline = process.argv.includes("--expect-baseline")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-pi-unparsed-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" })

const project = join(root, "project")
mkdirSync(project)
const target = join(project, "render.ts")
const original = "export function render(): string {\n\tlet text = \"\";\n\treturn text;\n}\n"
const expected = "export function render(): string {\n\tconst text = \"ok\";\n\treturn text;\n}\n"
writeFileSync(target, original)
const receipt = `RECEIPT-${randomUUID()}`
const toolId = "toolu_pi_raw_tab"
// Literal TABs inside the JSON strings, split mid-string as the API streams.
const rawTabDeltas = [
  `{"path":${JSON.stringify(target)},"edits":[{"oldText":"\tlet text = \\"\\";`,
  '","newText":"\tconst text = \\"ok\\";"}]}',
]
assert.throws(() => JSON.parse(rawTabDeltas.join("")), "The fixture must hold invalid strict JSON")

const rejections = []
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
  const body = await request.json()
  const editTool = body.tools?.find(tool => tool.name.endsWith("edit"))
  const history = JSON.stringify(body.messages)
  // The follow-up replays the client's result into a fresh SDK session, as
  // structured blocks or replay text; either names the call.
  const sawClientResult = history.includes(toolId)
  const blocks = editTool && !sawClientResult
    ? [{ type: "tool_use", id: toolId, name: editTool.name, input: {}, partialJson: rawTabDeltas }]
    : [{ type: "text", text: sawClientResult && history.includes("Successfully") ? receipt : "fixture idle" }]
  const events = [{ type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant",
    content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }]
  for (const [index, block] of blocks.entries()) {
    const { partialJson = [], ...start } = block
    events.push({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : start },
      ...(block.type === "text" ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]
        : partialJson.map(partial_json => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }))),
      { type: "content_block_stop", index })
  }
  events.push({ type: "message_delta", delta: { stop_reason: blocks[0].type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 20 } }, { type: "message_stop" })
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } })
} })

const realQuery = sdk.query
const observer = spyOn(sdk, "query").mockImplementation(input => {
  const actual = realQuery(input)
  return new Proxy(actual, { get(target, property) {
    if (property === Symbol.asyncIterator) return async function* () {
      for await (const message of actual) {
        if (message.type === "user") {
          for (const block of message.message?.content ?? []) {
            if (block.type === "tool_result" && JSON.stringify(block.content).includes("could not be parsed as JSON")) {
              rejections.push(block.tool_use_id)
            }
          }
        }
        yield message
      }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
})

const { startProxyServer } = await import("../src/proxy/server.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "fixture", type: "api", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${upstream.port}` }],
})
const address = proxy.server.address()
assert(address && typeof address === "object")
const agentDir = join(root, "pi-agent")
mkdirSync(agentDir)
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: {
  baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "local-test-key", headers: { "x-meridian-agent": "pi" },
  compat: { sendSessionAffinityHeaders: true },
  models: [{ id: "claude-opus-5-5", name: "Fixture via Meridian", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
} } }))

try {
  // Asynchronous: the proxy and fixture serve Pi from this same process.
  const pi = await new Promise((resolve, reject) => {
    const child = spawn(process.env.E2E_PI_BIN ?? "pi", ["-p", "--provider", "anthropic", "--model", "claude-opus-5-5",
      "--no-extensions", "--no-mcp", "--no-skills", "--session-dir", join(root, "pi-sessions"), "--tools", "read,edit",
      "Apply the planned edit to render.ts."], {
      cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk })
    child.stderr.on("data", chunk => { output += chunk })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 180_000)
    child.on("error", reject)
    child.on("close", status => { clearTimeout(deadline); resolve({ status, output }) })
  })
  const output = pi.output
  const outcome = { status: pi.status, rejections, edited: readFileSync(target, "utf8") === expected,
    receipt: output.includes(receipt), maxTurnsError: output.includes("maximum number of turns") }
  console.log(JSON.stringify({ root, ...outcome }))
  assert.deepEqual(rejections, [toolId], "Real CLI did not reject the raw-TAB arguments as unparseable")
  if (expectBaseline) {
    assert(!outcome.edited, "Baseline unexpectedly delivered the edit")
    assert(outcome.maxTurnsError, output)
  } else {
    assert.equal(pi.status, 0, output)
    assert(outcome.edited, `Pi did not apply the edit:\n${readFileSync(target, "utf8")}\n${output}`)
    assert(outcome.receipt, output)
    assert(!outcome.maxTurnsError, output)
  }
  console.log(JSON.stringify({ result: "PASS", expectBaseline }))
} finally {
  await proxy.close()
  await upstream.stop(true)
  observer.mockRestore()
}
