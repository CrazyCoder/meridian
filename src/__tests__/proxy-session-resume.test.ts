/**
 * Session Resume Tests
 *
 * The proxy should track Claude SDK session IDs and resume conversations
 * instead of starting fresh every time. This avoids re-processing the
 * entire conversation history and gives Claude better context.
 *
 * Session tracking uses:
 * 1. x-opencode-session header (primary — reliable, from OpenCode plugin)
 * 2. Conversation fingerprint (fallback — hash of first user message)
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null
let queryCallCount = 0

// Simulate SDK returning a session_id in messages
const MOCK_SDK_SESSION = "sdk-session-abc123"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    queryCallCount++
    return (async function* () {
      for (const msg of mockMessages) {
        // Inject session_id into messages (like the real SDK does)
        yield { ...msg, session_id: MOCK_SDK_SESSION }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: {},
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function readStreamFull(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

// ============================================================
// SESSION TRACKING
// ============================================================

describe("Session resume: session ID tracking", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should return X-Claude-Session-ID header in response", async () => {
    const app = createTestApp()
    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    })

    const sessionHeader = response.headers.get("x-claude-session-id")
    expect(sessionHeader).toBeTruthy()
  })

  it("should return X-Claude-Session-ID in streaming response", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hi"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    })

    const sessionHeader = response.headers.get("x-claude-session-id")
    expect(sessionHeader).toBeTruthy()
    await readStreamFull(response) // consume
  })

  it("should use resume option on follow-up requests with same session", async () => {
    const app = createTestApp()

    // First request — establishes session
    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-1" })
    await r1.json()

    const firstCallParams = { ...capturedQueryParams }

    // Second request — same session, should resume
    mockMessages = [
      assistantMessage([{ type: "text", text: "I remember!" }]),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Do you remember me?" },
      ],
    }, { "x-opencode-session": "oc-session-1" })
    await r2.json()

    // Second call should have resume option set
    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })

  it("should NOT resume for a different session ID", async () => {
    const app = createTestApp()

    // First request — session A
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-A" })).json()

    // Second request — session B (different)
    mockMessages = [
      assistantMessage([{ type: "text", text: "New conversation" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-B" })).json()

    // Should NOT have resume set (different session)
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })

  it("resumes Claude Code after a tool_result using metadata session ID", async () => {
    const app = createTestApp()
    const metadata = {
      user_id: JSON.stringify({
        device_id: "device-1",
        account_uuid: "",
        session_id: "claude-code-session-1",
      }),
    }
    const headers = { "user-agent": "claude-cli/2.1.207" }

    await (await post(app, {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      metadata,
      messages: [{ role: "user", content: "Run the tests" }],
    }, headers)).json()

    mockMessages = [assistantMessage([{ type: "text", text: "The test failed." }])]
    await (await post(app, {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      metadata,
      messages: [
        { role: "user", content: "Run the tests" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Exit code 1" }],
        },
      ],
    }, headers)).json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })
})

// ============================================================
// FINGERPRINT FALLBACK
// ============================================================

describe("Session resume: fingerprint fallback", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should resume via fingerprint when no session header is present", async () => {
    const app = createTestApp()

    // First request — no header, fingerprint tracked
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "What is the meaning of life?" }],
    })).json()

    // Second request — same first message, should resume
    mockMessages = [
      assistantMessage([{ type: "text", text: "42" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "What is the meaning of life?" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Tell me more" },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })

  it("keeps Claude Code fingerprint resume for tool_result without metadata", async () => {
    const app = createTestApp()
    const headers = { "user-agent": "claude-cli/2.1.207" }

    await (await post(app, {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Check the build" }],
    }, headers)).json()

    await (await post(app, {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Check the build" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "npm run build" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "Build complete" }],
        },
      ],
    }, headers)).json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })

  it("does not resume a headerless client tool loop when runtime context follows the tool result", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Run the tool" }],
    })).json()

    mockMessages = [
      assistantMessage([{ type: "text", text: "The tool returned TOOLCHECK_OK." }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_client", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_client", content: "TOOLCHECK_OK" }],
        },
        {
          role: "user",
          content: "Client runtime context for the immediately preceding user message.",
        },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.prompt).toContain("TOOLCHECK_OK")
  })

  it("does not resume headerless history after a completed tool loop and a later user request", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Run the tool" }],
    })).json()

    mockMessages = [
      assistantMessage([{ type: "text", text: "Here is the follow-up." }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_done", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOLCHECK_OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "The tool succeeded." }] },
        { role: "user", content: "Tell me more." },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.prompt).toContain("TOOLCHECK_OK")

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_done", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOLCHECK_OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "The tool succeeded." }] },
        { role: "user", content: "Tell me more." },
        { role: "assistant", content: [{ type: "text", text: "Here is the follow-up." }] },
        { role: "user", content: "Continue." },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
  })

  it("should NOT resume when first user message is different", async () => {
    const app = createTestApp()

    // First request
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello world" }],
    })).json()

    // Second request — different first message
    mockMessages = [
      assistantMessage([{ type: "text", text: "Different" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Goodbye world" }],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

// ============================================================
// LAST USER MESSAGE EXTRACTION
// ============================================================

describe("Session resume: only send last user message on resume", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should send only the last user message when resuming", async () => {
    const app = createTestApp()

    // First request — establish session
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "First message" }],
    }, { "x-opencode-session": "oc-resume-test" })).json()

    // Second request — resuming, has full history
    mockMessages = [
      assistantMessage([{ type: "text", text: "Continued" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Second message - this is the new one" },
      ],
    }, { "x-opencode-session": "oc-resume-test" })).json()

    // The prompt should only contain the last user message, not the full history
    expect(capturedQueryParams.prompt).toContain("Second message - this is the new one")
    expect(capturedQueryParams.prompt).not.toContain("First message")
  })

  it("should resume in streaming mode too", async () => {
    const app = createTestApp()

    // First request — establish session (non-streaming)
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Start conversation" }],
    }, { "x-opencode-session": "oc-stream-resume" })).json()

    // Second request — streaming, should resume
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Resumed!"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: "Start conversation" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Continue please" },
      ],
    }, { "x-opencode-session": "oc-stream-resume" })

    await readStreamFull(r2)
    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    expect(capturedQueryParams.prompt).toContain("Continue please")
    expect(capturedQueryParams.prompt).not.toContain("Start conversation")
  })

  it("should send full history on first request (no resume)", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: "Second message" },
      ],
    }, { "x-opencode-session": "oc-new-session" })).json()

    // No resume — should include full history
    expect(capturedQueryParams.prompt).toContain("First message")
    expect(capturedQueryParams.prompt).toContain("Second message")
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

// ============================================================
// EMBEDDED RUNTIME SESSION DESCRIPTOR
// ============================================================

/**
 * The guard above disables resume for headerless clients that drive their own
 * tool loop, because their (first user message, cwd) fingerprint is not unique
 * and one conversation can resume another's session.
 *
 * A client that publishes a stable session identifier in its system prompt has
 * an exact key, so the collision the guard protects against cannot happen and
 * resume must stay enabled — otherwise every turn is fresh-replayed and the
 * prompt cache decays to the static prefix while the whole history is rewritten.
 */
describe("Session resume: embedded runtime session descriptor", () => {
  const SESSION_A = "Runtime: agent=main | session=agent:main:a | sessionId=11111111-1111-4111-8111-111111111111 | host=box"
  const SESSION_B = "Runtime: agent=main | session=agent:main:b | sessionId=22222222-2222-4222-8222-222222222222 | host=box"

  function systemFor(runtime: string) {
    return [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: `## Runtime\n${runtime}` },
    ]
  }

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("resumes after a completed tool loop and a later user request", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(SESSION_A),
      messages: [{ role: "user", content: "Run the tool" }],
    })).json()

    mockMessages = [assistantMessage([{ type: "text", text: "Here is the follow-up." }])]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(SESSION_A),
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_done", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOLCHECK_OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "The tool succeeded." }] },
        { role: "user", content: "Tell me more." },
      ],
    })).json()

    // Resumed, and only the delta is replayed — not the whole history.
    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    expect(capturedQueryParams.prompt).toContain("Tell me more.")
    expect(capturedQueryParams.prompt).not.toContain("Run the tool")
  })

  it("keeps two concurrent conversations on separate sessions", async () => {
    const app = createTestApp()

    // Identical first message and no cwd: these two would share one
    // fingerprint, which is exactly the collision the descriptor removes.
    const firstTurn = [{ role: "user", content: "Run the tool" }]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(SESSION_A),
      messages: firstTurn,
    })).json()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(SESSION_B),
      messages: firstTurn,
    })).json()

    // B is a distinct conversation, so it must not have resumed A's session.
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })

  it("still refuses to resume a headerless client with no descriptor", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Run the tool" }],
    })).json()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_done", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOLCHECK_OK" }],
        },
        { role: "user", content: "Tell me more." },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

/**
 * Same guard, second descriptor form: a client that publishes no identifier for
 * the conversation but does describe where it is happening. The derived key is
 * chat-scoped rather than session-scoped, so these tests pin both halves of
 * that contract — turns of one conversation resume, and a later conversation in
 * the same chat does not inherit the earlier one's history.
 */
describe("Session resume: session context descriptor", () => {
  function systemFor(source: string) {
    return [
      { type: "text", text: "You are a helpful assistant." },
      {
        type: "text",
        text: `## Current Session Context\n\n**Source:** ${source}\n**User:** "Sam"\n`
          + "**Connected Platforms:** local (files on this machine)\n",
      },
    ]
  }

  const CHAT_A = 'Chat ("DM with Sam, thread: 555285")'
  const CHAT_B = 'Chat ("group: Ops")'

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("resumes after a completed tool loop and a later user request", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_A),
      messages: [{ role: "user", content: "Run the tool" }],
    })).json()

    mockMessages = [assistantMessage([{ type: "text", text: "Here is the follow-up." }])]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_A),
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_done", name: "exec", input: { command: "date" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "TOOLCHECK_OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "The tool succeeded." }] },
        { role: "user", content: "Tell me more." },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    expect(capturedQueryParams.prompt).toContain("Tell me more.")
    expect(capturedQueryParams.prompt).not.toContain("Run the tool")
  })

  it("keeps conversations in different chats on separate sessions", async () => {
    const app = createTestApp()

    // Identical first message and no cwd: one shared fingerprint, two chats.
    const firstTurn = [{ role: "user", content: "Run the tool" }]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_A),
      messages: firstTurn,
    })).json()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_B),
      messages: firstTurn,
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
  })

  it("does not let a later conversation in the same chat inherit the earlier history", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_A),
      messages: [
        { role: "user", content: "First conversation" },
        { role: "assistant", content: [{ type: "text", text: "Sure." }] },
        { role: "user", content: "Still the first conversation" },
      ],
    })).json()

    // The chat is the same, so the key is too — lineage verification is what
    // has to reject this, and it must, because the history shares no prefix.
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: systemFor(CHAT_A),
      messages: [{ role: "user", content: "A brand new conversation" }],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.prompt).toContain("A brand new conversation")
    expect(capturedQueryParams.prompt).not.toContain("First conversation")
  })
})
