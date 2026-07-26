/**
 * Tests for the Custom adapter and embedded runtime session-descriptor
 * extraction.
 *
 * Headerless clients that replay full history and publish a stable session
 * identifier in their system prompt are keyed by that identifier instead of the
 * weak (first user message, cwd) conversation fingerprint.
 */
import { describe, it, expect } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { customAdapter, EMBEDDED_SESSION_KEY_PREFIX } from "../proxy/adapters/custom"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { droidAdapter } from "../proxy/adapters/droid"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"
import {
  extractEmbeddedSessionId,
  getSystemPromptText,
  EMBEDDED_SESSION_PATTERN,
} from "../proxy/session/fingerprint"

const RUNTIME_LINE =
  "Runtime: agent=main | session=agent:main:abc | sessionId=907d2921-8089-45c3-bd9f-49b121285606"
  + " | host=box | repo=/tmp/ws | os=Linux | model=x/y | shell=zsh | channel=web"
const SESSION_ID = "907d2921-8089-45c3-bd9f-49b121285606"

function bodyWithRuntime(): any {
  return {
    system: [
      { type: "text", text: "You are a helpful assistant.\nLots of static preamble." },
      { type: "text", text: `## Runtime\n${RUNTIME_LINE}\nCurrent model identity: x/y.` },
    ],
    messages: [{ role: "user", content: "hi" }],
  }
}

function makeContext(headers: Record<string, string> = {}): any {
  const all: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = v
  return {
    req: {
      header: (name?: string) => (name ? all[name.toLowerCase()] : { ...all }),
    },
  }
}

describe("getSystemPromptText", () => {
  it("returns a bare string system prompt as-is", () => {
    expect(getSystemPromptText({ system: "hello" })).toBe("hello")
  })

  it("joins text blocks of an array system prompt", () => {
    expect(getSystemPromptText({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }))
      .toBe("a\nb")
  })

  it("ignores non-text blocks and missing text", () => {
    expect(getSystemPromptText({ system: [{ type: "image" }, { type: "text" }, { type: "text", text: "keep" }] }))
      .toBe("keep")
  })

  it("returns an empty string when there is no system prompt", () => {
    expect(getSystemPromptText({})).toBe("")
    expect(getSystemPromptText(undefined)).toBe("")
    expect(getSystemPromptText({ system: 42 })).toBe("")
  })
})

describe("extractEmbeddedSessionId", () => {
  it("extracts the identifier from an array system prompt", () => {
    expect(extractEmbeddedSessionId(bodyWithRuntime())).toBe(SESSION_ID)
  })

  it("extracts the identifier from a string system prompt", () => {
    expect(extractEmbeddedSessionId({ system: `intro\n${RUNTIME_LINE}\noutro` })).toBe(SESSION_ID)
  })

  it("returns undefined when no runtime descriptor is present", () => {
    expect(extractEmbeddedSessionId({ system: "You are a helpful assistant." })).toBeUndefined()
    expect(extractEmbeddedSessionId({})).toBeUndefined()
  })

  it("does not match a session key that carries no identifier", () => {
    expect(extractEmbeddedSessionId({ system: "Runtime: agent=main | session=agent:main:abc" }))
      .toBeUndefined()
  })

  it("requires the descriptor to start its own line", () => {
    // Guards against matching prose that merely mentions the marker.
    expect(extractEmbeddedSessionId({ system: `see Runtime: sessionId=${SESSION_ID}` }))
      .toBeUndefined()
  })

  it("does not run across lines", () => {
    expect(extractEmbeddedSessionId({ system: `Runtime: agent=main\nsessionId=${SESSION_ID}` }))
      .toBeUndefined()
  })

  it("accepts a caller-supplied pattern", () => {
    expect(extractEmbeddedSessionId({ system: "conv-id: xyz789" }, /conv-id: (\w+)/))
      .toBe("xyz789")
  })

  it("accepts non-hex identifier formats", () => {
    expect(extractEmbeddedSessionId({ system: "Runtime: sessionId=sess_9f2ab41c" }))
      .toBe("sess_9f2ab41c")
  })

  it("rejects a short placeholder rather than bucketing every conversation together", () => {
    // Keying all conversations to one shared bucket is worse than no key.
    expect(extractEmbeddedSessionId({ system: "Runtime: sessionId=unknown" })).toBeUndefined()
    expect(extractEmbeddedSessionId({ system: "Runtime: sessionId=none" })).toBeUndefined()
    expect(extractEmbeddedSessionId({ system: "Runtime: sessionId=n/a" })).toBeUndefined()
  })

  it("exposes the default pattern", () => {
    expect(EMBEDDED_SESSION_PATTERN.test(RUNTIME_LINE)).toBe(true)
  })
})

describe("customAdapter", () => {
  it("derives a namespaced session key from the embedded descriptor", () => {
    expect(customAdapter.getSessionId(makeContext(), bodyWithRuntime()))
      .toBe(`${EMBEDDED_SESSION_KEY_PREFIX}${SESSION_ID}`)
  })

  it("namespaces embedded keys so they cannot collide with header-supplied ids", () => {
    // A client sending this exact id as a header must not land on the same key.
    const viaHeader = customAdapter.getSessionId(
      makeContext({ "x-opencode-session": SESSION_ID }), { system: "plain" })
    const viaDescriptor = customAdapter.getSessionId(makeContext(), bodyWithRuntime())
    expect(viaHeader).toBe(SESSION_ID)
    expect(viaDescriptor).not.toBe(viaHeader)
  })

  it("prefers an explicit session header over the embedded descriptor", () => {
    const c = makeContext({ "x-opencode-session": "hdr-123" })
    expect(customAdapter.getSessionId(c, bodyWithRuntime())).toBe("hdr-123")
  })

  it("returns undefined when neither header nor descriptor is present", () => {
    expect(customAdapter.getSessionId(makeContext(), { system: "plain" })).toBeUndefined()
    expect(customAdapter.getSessionId(makeContext(), undefined)).toBeUndefined()
  })

  it("reports the OpenCode adapter as its base so name-keyed behavior is unchanged", () => {
    expect(customAdapter.name).toBe("custom")
    expect(customAdapter.baseName).toBe(openCodeAdapter.name)
  })

  it("inherits OpenCode tool configuration", () => {
    expect(customAdapter.getMcpServerName()).toBe(openCodeAdapter.getMcpServerName())
    expect(customAdapter.getBlockedBuiltinTools()).toEqual(openCodeAdapter.getBlockedBuiltinTools())
  })
})

describe("detectAdapter — embedded runtime descriptor", () => {
  it("selects the custom adapter for a headerless request carrying the descriptor", () => {
    expect(detectAdapter(makeContext(), bodyWithRuntime())).toBe(customAdapter)
  })

  it("falls back to the default adapter when the body is not supplied", () => {
    // server.ts detects once before parsing (for the error path) and again after.
    expect(detectAdapter(makeContext())).toBe(openCodeAdapter)
  })

  it("falls back to the default adapter when the descriptor is absent", () => {
    expect(detectAdapter(makeContext(), { system: "plain", messages: [] })).toBe(openCodeAdapter)
  })

  it("lets an explicit x-meridian-agent override win", () => {
    const c = makeContext({ "x-meridian-agent": "droid" })
    expect(detectAdapter(c, bodyWithRuntime())).toBe(droidAdapter)
  })

  it("is selectable explicitly like any other adapter", () => {
    const c = makeContext({ "x-meridian-agent": "custom" })
    expect(detectAdapter(c)).toBe(customAdapter)
  })

  it("lets a session header win", () => {
    const c = makeContext({ "x-opencode-session": "s1" })
    expect(detectAdapter(c, bodyWithRuntime())).toBe(openCodeAdapter)
  })

  it("lets a known User-Agent win", () => {
    expect(detectAdapter(makeContext({ "user-agent": "factory-cli/1.0.0" }), bodyWithRuntime()))
      .toBe(droidAdapter)
    expect(detectAdapter(makeContext({ "user-agent": "claude-cli/2.0.0" }), bodyWithRuntime()))
      .toBe(claudeCodeAdapter)
  })

  it("does not disturb detection for bodies from other clients", () => {
    const openCodeBody = {
      system: [{ type: "text", text: "<env>\n  Working directory: /tmp/p\n</env>" }],
      messages: [{ role: "user", content: "hi" }],
    }
    expect(detectAdapter(makeContext(), openCodeBody)).toBe(openCodeAdapter)
  })
})
