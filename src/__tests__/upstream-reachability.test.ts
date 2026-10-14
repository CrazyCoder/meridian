/**
 * Upstream reachability: the classifier, the evidence read off SDK messages,
 * and the state machine that turns them into a readiness answer.
 *
 * The clock is injected everywhere, so minutes-long windows are exercised
 * without waiting for them.
 */

import { describe, expect, it } from "bun:test"
import {
  answeredOverHttp,
  classifyConnectionFailure,
  DEFAULT_REACHABILITY_THRESHOLDS,
  observeReachability,
  reachabilityEvidence,
  unreachableDetail,
  UpstreamReachability,
  withReachability,
  type ConnectionFailureKind,
  type ReachabilityThresholds,
} from "../proxy/upstreamReachability"

const T0 = Date.parse("2026-10-01T21:00:00.000Z")
const SECOND = 1000
const MINUTE = 60 * SECOND

// Fixtures for reported CLI wordings. These pure controls do not establish the
// actual SDK 0.2.141 / CLI 2.1.284 event dialect or affected-flow acceptance.
const DNS = "Claude Code returned an error result: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"

function assistant(text: string, extra: Record<string, unknown> = {}, model = "claude-opus-5-5", id = "response-1") {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, type: "message", role: "assistant", model, content: [{ type: "text", text }] },
    ...extra,
  }
}

function streamStart(id = "response-1", parent: string | null = null) {
  return {
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [] } },
  }
}

function retry(status: unknown, attempt = 1) {
  return { type: "system", subtype: "api_retry", error_status: status, error: "unknown", attempt, uuid: `retry-${attempt}` }
}

function tracker(thresholds: ReachabilityThresholds = DEFAULT_REACHABILITY_THRESHOLDS) {
  const clock = { now: T0 }
  const reach = new UpstreamReachability(() => clock.now, () => thresholds)
  return { clock, reach }
}

describe("classifyConnectionFailure", () => {
  it.each<[string, ConnectionFailureKind]>([
    [DNS, "dns"],
    ["API Error: Can’t reach the API server — check your internet or DNS (EAI_AGAIN)", "dns"],
    ["API Error: Can't reach the API server — check your internet or DNS (FailedToOpenSocket)", "dns"],
    ["API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", "refused"],
    ["API Error: Connection dropped (ECONNRESET)", "reset"],
    ["API Error: No internet route — check your connection or VPN (EHOSTUNREACH)", "unroutable"],
    ["API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel", "proxy"],
    ["API Error: Unable to connect to API: SSL certificate has expired", "tls"],
    ["API Error: Unable to connect to API: Self-signed certificate detected (SELF_SIGNED_CERT_IN_CHAIN)", "tls"],
    ["API Error: Unable to connect to API (UND_ERR_CONNECT_TIMEOUT)", "timeout"],
    ["API Error: Unable to connect to API (ENOTFOUND)", "dns"],
    ["API Error: Unable to connect to API (ECONNREFUSED)", "refused"],
    ["API Error: Unable to connect to API (ESOMETHINGNEW)", "connection"],
    ["API Error: Unable to connect to API. Check your internet connection", "connection"],
    // A crash exit carries the CLI's report on a stderr line.
    ["Claude Code process exited with code 1\nSubprocess stderr: API Error: Connection dropped (EPIPE)", "reset"],
  ])("%s -> %s", (text, kind) => {
    expect(classifyConnectionFailure(text)).toBe(kind)
  })

  // Each of these would take a healthy instance out of rotation if it matched.
  it.each([
    "429 rate limit reached for this account",
    "Claude Code returned an error result: You've hit your limit · resets 3pm",
    "API Error: 529 Overloaded",
    "API Error: 401 authentication_error",
    // A slow upstream, not an unreachable one.
    "API Error: Request timed out.",
    "API Error: Request timed out. Check your internet connection and proxy settings",
    "API Error: Unable to connect to API (ETIMEDOUT)",
    "API Error: Connection error.",
    // An MCP server reporting its OWN dependency, without the CLI's prefix.
    "Claude Code process exited with code 1\nSubprocess stderr: [mcp] connection refused (ECONNREFUSED) talking to postgres",
    // Quoted mid-line in an assistant turn.
    "The log said API Error: Can't reach the API server, which is odd",
    "ECONNREFUSED",
    "API Error: Connection error. Retrying in 3s",
    "",
  ])("not a connection failure: %s", (text) => {
    expect(classifyConnectionFailure(text)).toBeNull()
  })

  it("accepts nothing that is not a string", () => {
    expect(classifyConnectionFailure(null)).toBeNull()
    expect(classifyConnectionFailure(undefined)).toBeNull()
  })
})

describe("answeredOverHttp", () => {
  it.each([100, 200, 400, 401, 403, 429, 500, 529, 599])("accepts a native query retry status: %s", (status) => {
    expect(answeredOverHttp(retry(status))).toBe(true)
  })

  it.each([
    "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long\"}}",
    "Claude Code returned an error result: API Error: 401 OAuth token has been revoked",
    "API Error: 529 Overloaded",
    "Claude Code process exited with code 1\nSubprocess stderr: API Error: 503 proxy gateway unavailable",
    DNS,
    "API Error: Connection error.",
    // Raised by the CLI itself, before any request leaves the host.
    "Not logged in · Please run /login",
    "Invalid API key · Fix external API key",
    // Quoted mid-line, or a number that is not a status.
    "The log said API Error: 401 earlier",
    "API Error: 4015 things",
    "handler.js:401:15",
    "",
  ])("text alone supplies no native HTTP response evidence: %s", (text) => {
    expect(answeredOverHttp(text)).toBe(false)
  })

  it("ignores absent messages", () => {
    expect(answeredOverHttp(null)).toBe(false)
    expect(answeredOverHttp(undefined)).toBe(false)
  })

  it.each([null, NaN, Infinity, -Infinity, 99, 600, 401.5, "529", Number.MAX_SAFE_INTEGER])("ignores an absent/malformed HTTP status: %s", (status) => {
    expect(answeredOverHttp(retry(status))).toBe(false)
  })

  it("requires a native retry envelope and a valid SDK marker", () => {
    expect(answeredOverHttp({ error_status: 529, error: "server_error" })).toBe(false)
    expect(answeredOverHttp({ ...retry(529), type: "assistant" })).toBe(false)
    expect(answeredOverHttp({ ...retry(529), error: "proxy_error" })).toBe(false)
    expect(answeredOverHttp({ ...retry(529), error: undefined })).toBe(false)
    expect(answeredOverHttp({ ...retry(529), isReplay: true })).toBe(false)
  })
})

describe("reachabilityEvidence", () => {
  it("ignores ambiguous no-response retries and counts valid native HTTP answers", () => {
    expect(reachabilityEvidence({ type: "system", subtype: "api_retry", error_status: null, error: "unknown" })).toBeNull()
    expect(reachabilityEvidence({ type: "system", subtype: "api_retry", error_status: 529, error: "server_error" }))
      .toEqual({ kind: "reached" })
  })

  it("counts a response starting, but not the deltas of one already open", () => {
    expect(reachabilityEvidence(streamStart())).toEqual({ kind: "reached" })
    expect(reachabilityEvidence({ type: "stream_event", event: { type: "content_block_delta" } })).toBeNull()
  })

  it("counts a real assistant message, not a synthetic one", () => {
    expect(reachabilityEvidence(assistant("hello"))).toEqual({ kind: "reached" })
    expect(reachabilityEvidence(assistant("No response requested.", {}, "<synthetic>"))).toBeNull()
  })

  it("reads the CLI's terminal error message for its connection failure", () => {
    expect(reachabilityEvidence(assistant("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { error: "unknown" }, "<synthetic>")))
      .toEqual({ kind: "failure", failure: "dns", terminal: true })
  })

  it("does not credit a bare refusal enum or locally raised error as an answer", () => {
    expect(reachabilityEvidence(assistant("You've hit your limit", { error: "rate_limit" }, "<synthetic>"))).toBeNull()
    expect(reachabilityEvidence(assistant("Credit balance is too low", { error: "billing_error" }, "<synthetic>"))).toBeNull()
    expect(reachabilityEvidence(assistant("Not logged in", { error: "authentication_failed" }, "<synthetic>"))).toBeNull()
    expect(reachabilityEvidence(assistant("Prompt is too long", { error: "invalid_request" }, "<synthetic>"))).toBeNull()
  })

  it("does not treat HTTP-looking terminal text as native transport evidence", () => {
    expect(reachabilityEvidence(assistant("API Error: 400 prompt is too long: 250000 tokens > 200000 maximum", { error: "invalid_request" }, "<synthetic>")))
      .toBeNull()
    expect(reachabilityEvidence(assistant("API Error: 401 OAuth token has been revoked", { error: "authentication_failed" }, "<synthetic>")))
      .toBeNull()
  })

  it("ignores everything else", () => {
    expect(reachabilityEvidence({ type: "result", subtype: "success", is_error: false })).toBeNull()
    expect(reachabilityEvidence({ type: "system", subtype: "init" })).toBeNull()
    expect(reachabilityEvidence(null)).toBeNull()
    expect(reachabilityEvidence("text")).toBeNull()
  })
})

describe("UpstreamReachability", () => {
  it("uses pure approved defaults without configuration readers and resets to those same defaults", () => {
    const names = ["MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS", "MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS", "MERIDIAN_UPSTREAM_UNREACHABLE_MIN_FAILURES"]
    const saved = new Map(names.map(name => [name, process.env[name]]))
    try {
      // A leaked configuration default would fail immediately under these
      // hostile values. The direct pure tracker uses no settings/fs mocks.
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS = "0"
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS = "600000"
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_MIN_FAILURES = "1"
      const clock = { now: T0 }
      const reach = new UpstreamReachability(() => clock.now)
      reach.recordFailure("dns")
      expect(reach.snapshot().state).toBe("ok")
      clock.now += MINUTE
      reach.recordFailure("dns")
      expect(reach.snapshot().state).toBe("ok")
      clock.now += MINUTE
      reach.recordFailure("dns")
      expect(reach.snapshot()).toMatchObject({ state: "unreachable", holdUntil: new Date(clock.now + 5 * MINUTE).toISOString() })
      clock.now += 5 * MINUTE
      expect(reach.snapshot().state).toBe("probing")
      reach.resetForTests(() => clock.now, () => ({ unreachableAfterMs: 0, holdMs: MINUTE, minFailures: 1 }))
      reach.recordFailure("dns")
      expect(reach.snapshot().state).toBe("unreachable")
      reach.resetForTests(() => clock.now)
      reach.recordFailure("dns")
      expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 1 })
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
  it("starts ok, with nothing observed", () => {
    const { reach } = tracker()
    expect(reach.snapshot()).toEqual({
      state: "ok",
      since: new Date(T0).toISOString(),
      failingSince: null,
      consecutiveFailures: 0,
      lastReachedAt: null,
      lastFailureAt: null,
      lastErrorKind: null,
      holdUntil: null,
      override: null,
    })
  })

  it("needs the minimum number of failures, however long they span", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("dns")
    clock.now += 5 * MINUTE
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
  })

  it("needs the failures to span the window, however many there are", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 10; i++) {
      reach.recordFailure("dns")
      clock.now += 10 * SECOND
    }
    expect(reach.snapshot().state).toBe("ok")
    expect(reach.snapshot().consecutiveFailures).toBe(10)
  })

  it("concludes unreachable once both hold, and reports the run", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("connection")
    clock.now += MINUTE
    reach.recordFailure("connection")
    clock.now += MINUTE
    reach.recordFailure("dns")
    const at = new Date(T0 + 2 * MINUTE).toISOString()
    expect(reach.snapshot()).toEqual({
      state: "unreachable",
      since: at,
      failingSince: new Date(T0).toISOString(),
      consecutiveFailures: 3,
      lastReachedAt: null,
      lastFailureAt: at,
      lastErrorKind: "dns",
      holdUntil: new Date(T0 + 2 * MINUTE + 5 * MINUTE).toISOString(),
      override: null,
    })
  })

  it("keeps holding while failures continue, then probes once they stop", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    // Last failure at T0+2m, now T0+3m: still inside the hold.
    reach.recordFailure("dns")
    expect(reach.snapshot().holdUntil).toBe(new Date(T0 + 3 * MINUTE + 5 * MINUTE).toISOString())
    clock.now += 5 * MINUTE - 1
    expect(reach.snapshot().state).toBe("unreachable")
    clock.now += 1
    const probing = reach.snapshot()
    expect(probing.state).toBe("probing")
    expect(probing.since).toBe(new Date(T0 + 8 * MINUTE).toISOString())
    expect(probing.holdUntil).toBeNull()
  })

  it("goes straight back to unreachable on a failure while probing", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(reach.snapshot().state).toBe("probing")
    reach.recordFailure("refused")
    const snapshot = reach.snapshot()
    expect(snapshot.state).toBe("unreachable")
    expect(snapshot.since).toBe(new Date(clock.now).toISOString())
    expect(snapshot.lastErrorKind).toBe("refused")
    // Never reached since the run began, so the run is the same outage.
    expect(snapshot.failingSince).toBe(new Date(T0).toISOString())
  })

  it("returns to ok at once on any answer, from every state", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("unreachable")
    reach.recordReached()
    const snapshot = reach.snapshot()
    expect(snapshot).toMatchObject({
      state: "ok",
      since: new Date(clock.now).toISOString(),
      failingSince: null,
      consecutiveFailures: 0,
      lastReachedAt: new Date(clock.now).toISOString(),
      holdUntil: null,
    })
    // The last failure stays on record for whoever is looking back.
    expect(snapshot.lastErrorKind).toBe("dns")

    clock.now += 10 * MINUTE
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(reach.snapshot().state).toBe("probing")
    reach.recordReached()
    expect(reach.snapshot().state).toBe("ok")
  })

  it("starts the window over after an answer, so failures either side of it never add up", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("dns")
    clock.now += MINUTE
    reach.recordFailure("dns")
    clock.now += 30 * SECOND
    reach.recordReached()
    clock.now += 10 * SECOND
    reach.recordFailure("dns")
    clock.now += 100 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
    clock.now += 30 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("unreachable")
    expect(reach.snapshot().failingSince).toBe(new Date(T0 + 100 * SECOND).toISOString())
  })

  it("never fails readiness with a zero hold, while still recording the run", () => {
    const { clock, reach } = tracker({ ...DEFAULT_REACHABILITY_THRESHOLDS, holdMs: 0 })
    for (let i = 0; i < 5; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("probing")
    expect(reach.snapshot().consecutiveFailures).toBe(5)
  })

  it("re-reads its thresholds on every evaluation", () => {
    let thresholds: ReachabilityThresholds = DEFAULT_REACHABILITY_THRESHOLDS
    const clock = { now: T0 }
    const reach = new UpstreamReachability(() => clock.now, () => thresholds)
    reach.recordFailure("dns")
    clock.now += 10 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
    thresholds = { unreachableAfterMs: 5 * SECOND, holdMs: MINUTE, minFailures: 2 }
    clock.now += SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("unreachable")
    thresholds = { ...thresholds, holdMs: 0 }
    expect(reach.snapshot().state).toBe("probing")
  })

  it("forces a state for a bounded time, over whatever traffic says", () => {
    const { clock, reach } = tracker()
    reach.force("unreachable", MINUTE)
    expect(reach.snapshot()).toMatchObject({
      state: "unreachable",
      override: { state: "unreachable", until: new Date(T0 + MINUTE).toISOString() },
      holdUntil: null,
    })
    reach.recordReached()
    expect(reach.snapshot().state).toBe("unreachable")
    clock.now += MINUTE
    expect(reach.snapshot()).toMatchObject({ state: "ok", override: null })

    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("unreachable")
    reach.force("ok", 10 * MINUTE)
    expect(reach.snapshot().state).toBe("ok")
    reach.clearOverride()
    expect(reach.snapshot().state).toBe("unreachable")
  })
})

describe("observeReachability", () => {
  const terminal = assistant("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { error: "unknown" }, "<synthetic>")

  it("counts the CLI's terminal report once, though it arrives as a message and again as the thrown error", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach)
    observer.message({ type: "system", subtype: "api_retry", error_status: null })
    observer.message(terminal)
    observer.error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "dns" })
  })

  it("counts the thrown error when no terminal message preceded it", () => {
    const { reach } = tracker()
    observeReachability(reach).error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "dns" })
  })

  it("leaves the tracker alone for an error that is not a connection failure", () => {
    const { reach } = tracker()
    observeReachability(reach).error(new Error("429 rate limit reached for this account"))
    expect(reach.snapshot().consecutiveFailures).toBe(0)
  })

  it("does not end the failure run on HTTP-looking thrown text", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach)
    reach.recordFailure("dns")
    observer.error(new Error("Claude Code returned an error result: API Error: 400 prompt is too long"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, failingSince: new Date(T0).toISOString(), lastReachedAt: null })
  })
})

describe("withReachability", () => {
  it("passes the stream through unchanged while reading it", async () => {
    const { reach } = tracker()
    const messages = [
      streamStart(),
      { type: "stream_event", event: { type: "content_block_delta" } },
    ]
    async function* source() { yield* messages }
    const seen: unknown[] = []
    for await (const message of withReachability(source(), reach)) seen.push(message)
    expect(seen).toEqual(messages)
    expect(reach.snapshot().lastReachedAt).toBe(new Date(T0).toISOString())
  })

  it("records a connection failure the stream throws, and rethrows it", async () => {
    const { reach } = tracker()
    async function* source(): AsyncGenerator<never> { throw new Error(DNS) }
    await expect((async () => { for await (const _ of withReachability(source(), reach)) { /* drain */ } })()).rejects.toThrow("Can't reach the API server")
    expect(reach.snapshot().lastErrorKind).toBe("dns")
  })
})

describe("unreachableDetail", () => {
  it("says nothing while the upstream may serve", () => {
    const { clock, reach } = tracker()
    expect(unreachableDetail(reach.snapshot())).toBeNull()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(unreachableDetail(reach.snapshot())).toBeNull()
  })

  it("names when it started, the last error, the count and the last answer", () => {
    const { clock, reach } = tracker()
    reach.recordReached()
    clock.now += SECOND
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(unreachableDetail(reach.snapshot())).toBe(
      "This instance's configured Claude egress failed since 2026-10-01T21:00:01.000Z (last error: dns, 3 connection failures, last answered 2026-10-01T21:00:00.000Z)",
    )
  })

  it("says when the state is forced", () => {
    const { reach } = tracker()
    reach.force("unreachable", MINUTE)
    expect(unreachableDetail(reach.snapshot())).toBe("This instance's configured Claude egress forced unreachable by override until 2026-10-01T21:01:00.000Z")
  })
})

describe("reachability state correction controls", () => {
  it("always exposes valid dates even when a supplied hold exceeds the Date range", () => {
    const { clock, reach } = tracker({ unreachableAfterMs: 0, minFailures: 1, holdMs: Number.MAX_SAFE_INTEGER })
    reach.recordFailure("dns")
    const snapshot = reach.snapshot()
    expect(snapshot.state).toBe("unreachable")
    expect(snapshot.holdUntil).toBe(new Date(clock.now + DEFAULT_REACHABILITY_THRESHOLDS.holdMs).toISOString())
  })

  it("reports the forced transition time while preserving observations underneath", () => {
    const { clock, reach } = tracker()
    clock.now += 10 * MINUTE
    reach.force("unreachable", MINUTE)
    expect(reach.snapshot().since).toBe(new Date(clock.now).toISOString())
    clock.now += SECOND
    reach.recordReached()
    expect(reach.snapshot()).toMatchObject({
      state: "unreachable",
      since: new Date(T0 + 10 * MINUTE).toISOString(),
      lastReachedAt: new Date(clock.now).toISOString(),
    })
    clock.now = T0 + 11 * MINUTE
    expect(reach.snapshot()).toMatchObject({ state: "ok", since: new Date(clock.now).toISOString(), override: null })
  })
})

describe("connection ambiguity and response correlation controls", () => {
  it("does not count no-response retry statuses as definite connection failures", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach)
    for (let i = 0; i < 3; i++) {
      observer.message({ type: "system", subtype: "api_retry", error_status: null, error: "unknown" })
      clock.now += MINUTE
    }
    observer.error(new Error("Claude Code returned an error result: API Error: Request timed out."))
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: null })
  })

  it("does not let an old streamed completion clear a newer failure run", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach)
    observer.message({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "old-response", type: "message", role: "assistant", model: "claude-opus-5-5", content: [] } },
    })
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    observer.message({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "old-response", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "finished" }] },
    })
    expect(reach.snapshot()).toMatchObject({ state: "unreachable", consecutiveFailures: 3, lastReachedAt: new Date(T0).toISOString() })
  })

  it("records only the start of each streamed response, including a later retry or tool-loop response", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: true })
    observer.message(streamStart("old"))
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    observer.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "still open" } } })
    observer.message(assistant("finished", {}, "claude-opus-5-5", "old"))
    observer.message(streamStart("old"))
    observer.message(assistant("unmatched body", {}, "claude-opus-5-5", "unmatched"))
    expect(reach.snapshot()).toMatchObject({ state: "unreachable", consecutiveFailures: 3, lastReachedAt: new Date(T0).toISOString() })
    observer.message(streamStart("fresh"))
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: new Date(clock.now).toISOString() })
    clock.now += SECOND
    reach.recordFailure("refused")
    observer.message(assistant("fresh completion", {}, "claude-opus-5-5", "fresh"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "refused" })
  })

  it("deduplicates nonstream content blocks while crediting a new native response", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: false })
    observer.message(assistant("first block", {}, "claude-opus-5-5", "blocks"))
    clock.now += MINUTE
    reach.recordFailure("dns")
    observer.message(assistant("second block", {}, "claude-opus-5-5", "blocks"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastReachedAt: new Date(T0).toISOString() })
    observer.message(assistant("another response", {}, "claude-opus-5-5", "later"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 0, lastReachedAt: new Date(clock.now).toISOString() })
  })

  it("keeps parent response identities distinct within one query", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: true })
    observer.message(streamStart("same-id", "child-1"))
    clock.now += MINUTE
    reach.recordFailure("dns")
    observer.message(streamStart("same-id", "child-2"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 0, lastReachedAt: new Date(clock.now).toISOString() })
  })

  it("deduplicates replayed native retry notices while allowing a new attempt's HTTP answer", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach)
    observer.message(retry(529, 1))
    clock.now += MINUTE
    reach.recordFailure("dns")
    observer.message(retry(529, 1))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastReachedAt: new Date(T0).toISOString() })
    observer.message(retry(429, 2))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 0, lastReachedAt: new Date(clock.now).toISOString() })
  })

  it("does not evict old response IDs or accept new proof after the query identity budget is full", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: true })
    for (let i = 0; i < 1024; i++) observer.message(streamStart(`bounded-${i}`))
    reach.recordFailure("dns")
    observer.message(streamStart("beyond-budget"))
    observer.message(streamStart("bounded-0"))
    expect(reach.snapshot().consecutiveFailures).toBe(1)
    // A new actual query owns its own correlation budget.
    observeReachability(reach, { includePartialMessages: true }).message(streamStart("new-query"))
    expect(reach.snapshot().consecutiveFailures).toBe(0)
  })

  it("retains a native terminal connection failure without needing a result or throw", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach)
    const terminal = assistant(DNS, { error: "unknown" }, "<synthetic>", "terminal")
    observer.message(terminal)
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "dns" })
    observer.message(terminal)
    observer.message({ type: "result", subtype: "error_during_execution", is_error: true, errors: [DNS] })
    observer.error(new Error(DNS))
    expect(reach.snapshot().consecutiveFailures).toBe(1)
    observer.message(assistant(DNS, { error: "unknown" }, "<synthetic>", "another-terminal"))
    expect(reach.snapshot().consecutiveFailures).toBe(2)
    observer.message(streamStart("recovered"))
    observer.error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 0, lastErrorKind: "dns" })
  })

  it("does not undo real recovery with an ambiguous late throw of the same terminal failure", () => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: true })
    observer.message(assistant(DNS, { error: "unknown" }, "<synthetic>", "old-terminal"))
    expect(reach.snapshot().consecutiveFailures).toBe(1)
    clock.now += SECOND
    observer.message(streamStart("recovery"))
    observer.error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: new Date(clock.now).toISOString() })
    observer.message(assistant(DNS, { error: "unknown" }, "<synthetic>", "distinct-terminal"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "dns" })
  })

  it.each([
    "API Error: Request timed out.",
    "API Error: Request timed out. Check your internet connection and proxy settings",
    "API Error: Unable to connect to API (ETIMEDOUT)",
    "API Error: Connection error.",
    "API Error: 503 proxy gateway unavailable",
  ])("does not fail readiness for ambiguous/local terminal text: %s", (text) => {
    const { clock, reach } = tracker()
    const observer = observeReachability(reach)
    for (let i = 0; i < 3; i++) {
      observer.message(assistant(text, { error: "unknown" }, "<synthetic>", `ambiguous-${i}`))
      observer.error(new Error(text))
      clock.now += MINUTE
    }
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: null })
  })

  it("ignores spoofed, replayed and malformed native response/error envelopes", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach, { includePartialMessages: true })
    const terminal = assistant(DNS, { error: "unknown" }, "<synthetic>")
    const spoofs: unknown[] = [
      { ...terminal, type: "user" },
      { ...terminal, type: "tool" },
      { ...terminal, error: undefined },
      { ...terminal, error: "mcp_dependency_failed" },
      { ...terminal, isReplay: true },
      { ...terminal, isSynthetic: true },
      { ...terminal, message: { ...terminal.message, model: "claude-opus-5-5" } },
      { ...terminal, message: { ...terminal.message, content: [{ type: "tool_result", text: DNS }] } },
      { ...terminal, message: { ...terminal.message, id: undefined } },
      { ...terminal, parent_tool_use_id: {} },
      assistant("No response requested.", {}, "<synthetic>"),
      assistant(DNS),
      { ...streamStart(), isReplay: true },
      { ...streamStart(), parent_tool_use_id: undefined },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, model: null } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, model: "<synthetic>" } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, model: {} } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, id: " " } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, id: "x".repeat(4097) } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { ...streamStart().event.message, role: "user" } } },
    ]
    for (const spoof of spoofs) observer.message(spoof)
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: null })
  })
})

describe("safe timing and override transitions", () => {
  it("saturates the public failure counter at a safe integer", () => {
    const { reach } = tracker()
    // Seed the otherwise unreachable boundary without trillions of iterations.
    Reflect.set(reach, "consecutiveFailures", Number.MAX_SAFE_INTEGER)
    reach.recordFailure("dns")
    expect(reach.snapshot().consecutiveFailures).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("bounds Date arithmetic and invalid clock readings at the last valid time", () => {
    const clock = { now: 8_640_000_000_000_000 - SECOND }
    const reach = new UpstreamReachability(() => clock.now, () => ({ unreachableAfterMs: 0, minFailures: 1, holdMs: 8_640_000_000_000_000 }))
    reach.recordFailure("dns")
    expect(reach.snapshot().holdUntil).toBe(new Date(8_640_000_000_000_000).toISOString())
    reach.force("ok", Number.MAX_SAFE_INTEGER)
    expect(reach.snapshot().override?.until).toBe(new Date(8_640_000_000_000_000).toISOString())
    clock.now = NaN
    expect(reach.snapshot().since).toBe(new Date(8_640_000_000_000_000 - SECOND).toISOString())
    clock.now = Infinity
    expect(() => reach.recordFailure("dns")).not.toThrow()
    expect(() => reach.snapshot()).not.toThrow()
  })

  it("normalizes injected malformed thresholds as well as persisted settings", () => {
    const { clock, reach } = tracker({ unreachableAfterMs: -1, minFailures: Number.MAX_SAFE_INTEGER + 1, holdMs: Infinity })
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot()).toMatchObject({ state: "unreachable", consecutiveFailures: 3, holdUntil: new Date(T0 + 7 * MINUTE).toISOString() })
  })

  it("resumes the natural outage at the clear transition, with observations intact", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    reach.force("ok", 10 * MINUTE)
    const forcedAt = clock.now
    clock.now += SECOND
    reach.recordFailure("refused")
    expect(reach.snapshot()).toMatchObject({ state: "ok", since: new Date(forcedAt).toISOString(), consecutiveFailures: 4, lastErrorKind: "refused" })
    clock.now += SECOND
    reach.clearOverride()
    expect(reach.snapshot()).toMatchObject({
      state: "unreachable", since: new Date(clock.now).toISOString(), failingSince: new Date(T0).toISOString(),
      consecutiveFailures: 4, holdUntil: new Date(forcedAt + SECOND + 5 * MINUTE).toISOString(), override: null,
    })
  })

  it("resumes probing at expiry and immediately holds again on the next definite failure", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    reach.force("ok", 10 * MINUTE)
    clock.now += 10 * MINUTE
    expect(reach.snapshot()).toMatchObject({ state: "probing", since: new Date(clock.now).toISOString(), consecutiveFailures: 3, override: null })
    reach.recordFailure("dns")
    expect(reach.snapshot()).toMatchObject({ state: "unreachable", since: new Date(clock.now).toISOString(), consecutiveFailures: 4 })
    reach.recordReached()
    expect(reach.snapshot()).toMatchObject({ state: "ok", since: new Date(clock.now).toISOString(), consecutiveFailures: 0 })
  })
})

describe("strict persisted and internal numeric field controls", () => {
  it("does not coerce numeric strings from injected thresholds", () => {
    const clock = { now: T0 }
    const thresholds = () => JSON.parse('{"unreachableAfterMs":"0","holdMs":"0","minFailures":"1"}')
    const reach = new UpstreamReachability(() => clock.now, thresholds)
    reach.recordFailure("dns")
    expect(reach.snapshot()).toMatchObject({ state: "ok", consecutiveFailures: 1 })
  })

  it("does not coerce a numeric string into an internal forced-state TTL", () => {
    const { reach } = tracker()
    Reflect.apply(reach.force, reach, ["unreachable", "1000"])
    expect(reach.snapshot().override?.until).toBe(new Date(T0 + 600_000).toISOString())
  })
})
