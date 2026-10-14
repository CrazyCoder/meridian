/**
 * Observed connection state for this instance's configured Claude egress, learned passively
 * from the traffic Meridian already carries.
 *
 * The failure this exists for: a host whose resolver died while its network
 * stayed up. Meridian kept answering HTTP and `/readyz` stayed green, so a load
 * balancer in front of two instances kept sending this one half the traffic,
 * and every request spent the CLI's whole retry budget before failing with
 * "API Error: Can't reach the API server". The instance could not serve, and
 * nothing it published said so.
 *
 * Only CONNECTION-class failures count against reachability: DNS, refused,
 * reset, unroutable, connect timeouts, TLS and proxy tunnel failures. A 429,
 * an auth refusal, a billing cap or a model error never do. A native SDK HTTP
 * retry status or a fresh real response establishes configured-egress transport
 * reachability. It does not establish the response's origin, account usability
 * or successful inference. HTTP-looking error text alone is insufficient.
 *
 * Nothing here sends a request of its own. The conclusion is drawn from real
 * requests, and the way back from it is a real request too: after a hold the
 * state turns to `probing`, readiness passes again, and the next request
 * either observes an egress answer (back to `ok`) or fails the same way (straight back
 * to `unreachable`, without waiting out another detection window).
 */

export type ConnectionFailureKind =
  | "dns"
  | "refused"
  | "reset"
  | "unroutable"
  | "timeout"
  | "tls"
  | "proxy"
  | "connection"

export type ReachabilityState = "ok" | "unreachable" | "probing"

export interface ReachabilityThresholds {
  /** Minimum span between the first and the latest failure of a run before
   *  the run counts as an outage rather than a blip. */
  readonly unreachableAfterMs: number
  /** How long `unreachable` holds after the latest failure before readiness
   *  passes again so a real request can test the way back. 0 never holds. */
  readonly holdMs: number
  /** Failures a run needs, however long it lasted. */
  readonly minFailures: number
}

export const DEFAULT_REACHABILITY_THRESHOLDS: ReachabilityThresholds = {
  unreachableAfterMs: 120_000,
  holdMs: 300_000,
  minFailures: 3,
}

/** Bounds for a forced state, so a forgotten test override expires. */
export const DEFAULT_OVERRIDE_TTL_MS = 600_000
export const MAX_OVERRIDE_TTL_MS = 86_400_000

const CODE_KINDS: Readonly<Record<string, ConnectionFailureKind>> = {
  enotfound: "dns",
  eai_again: "dns",
  failedtoopensocket: "dns",
  econnrefused: "refused",
  connectionrefused: "refused",
  econnreset: "reset",
  epipe: "reset",
  econnaborted: "reset",
  connectionclosed: "reset",
  err_socket_closed: "reset",
  und_err_socket: "reset",
  enetunreach: "unroutable",
  enetdown: "unroutable",
  ehostunreach: "unroutable",
  ehostdown: "unroutable",
  und_err_connect_timeout: "timeout",
  err_proxy_tunnel: "proxy",
}

/**
 * The CLI's connection errors, in the wording it actually prints.
 *
 * The reported native terminal dialect starts with an `API Error:` prefix.
 * The public SDK declarations do not establish the target CLI's actual error
 * envelopes; affected-flow qualification remains required. The
 * prefix is REQUIRED, at the start of a line after the known wrappers, because
 * this classification can take a whole instance out of a load balancer: an MCP
 * server's stderr saying "connection refused" about its own database, or an
 * assistant turn quoting the phrase, must not count. The same reason the quota
 * patterns in errors.ts are line-anchored.
 */
const API_ERROR_LINE = String.raw`(?:^|\n)[ \t]*(?:(?:error|claude code returned an error result|subprocess stderr):[ \t]*)*api error:[ \t]*`
/** The first `(CODE)` later on the same line, when there is one. */
const CODE = String.raw`(?:[^\n]*?\(([a-z0-9_]+)\))?`
const CONNECTION_PHRASES: ReadonlyArray<{ readonly pattern: RegExp; readonly kind: ConnectionFailureKind }> = [
  // 2.1.284: ENOTFOUND, EAI_AGAIN, FailedToOpenSocket.
  { pattern: new RegExp(API_ERROR_LINE + String.raw`can't reach the api server\b` + CODE), kind: "dns" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`connection refused\b` + CODE), kind: "refused" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`connection dropped\b` + CODE), kind: "reset" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`no internet route\b` + CODE), kind: "unroutable" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`couldn't connect through your proxy\b` + CODE), kind: "proxy" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`unable to connect to api: (?:ssl|self-signed)`), kind: "tls" },
  // The code-only fallback, and the older wordings without a code.
  { pattern: new RegExp(API_ERROR_LINE + String.raw`unable to connect to api` + CODE), kind: "connection" },
]

/**
 * The kind of connection failure an SDK error or API error text reports, or
 * null when it reports anything else.
 *
 * A bare "Request timed out." is deliberately NOT here: the CLI says that when
 * a request got no answer in time, which does not distinguish a slow upstream
 * from an unreachable one. Internet/proxy advice and ETIMEDOUT do not resolve
 * that ambiguity. Only an explicit connect-timeout code counts as a timeout.
 */
export function classifyConnectionFailure(text: string | null | undefined): ConnectionFailureKind | null {
  if (typeof text !== "string" || text.length === 0) return null
  const lower = text.toLowerCase().replace(/\u2019/g, "'")
  for (const { pattern, kind } of CONNECTION_PHRASES) {
    const match = pattern.exec(lower)
    if (!match) continue
    const code = match[1]
    if (code === "etimedout") return null
    return (code && CODE_KINDS[code]) || kind
  }
  return null
}

const SDK_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error", "rate_limit",
  "invalid_request", "server_error", "unknown", "max_output_tokens",
])

/** What one SDK message says about reachability. */
export type ReachabilityEvidence =
  | { readonly kind: "reached" }
  | { readonly kind: "failure"; readonly failure: ConnectionFailureKind; readonly terminal: boolean }
  | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Native retry statuses establish an HTTP transport answer on this query's
 *  configured egress. They do not establish Anthropic origin or inference.
 *  A null status covers slow/read timeouts too, so supplies no evidence. */
export function answeredOverHttp(message: unknown): boolean {
  return isRecord(message) && !isReplayOrSynthetic(message)
    && message.type === "system" && message.subtype === "api_retry"
    && typeof message.error === "string" && SDK_ASSISTANT_ERRORS.has(message.error)
    && typeof message.error_status === "number" && Number.isInteger(message.error_status)
    && message.error_status >= 100 && message.error_status <= 599
}

function isReplayOrSynthetic(message: Record<string, unknown>): boolean {
  return message.isReplay === true || message.isSynthetic === true
    || message.is_replay === true || message.is_synthetic === true
}

const MAX_OBSERVATION_ID_LENGTH = 4096
const MAX_RESPONSE_IDENTITIES = 1024

function observationId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_OBSERVATION_ID_LENGTH
}

function responseIdentity(message: Record<string, unknown>, inner: Record<string, unknown>): string | null {
  if (!observationId(inner.id)) return null
  const parent = message.parent_tool_use_id
  if (parent !== null && !observationId(parent)) return null
  return JSON.stringify([parent, inner.id])
}

function isRealResponse(inner: unknown): inner is Record<string, unknown> {
  return isRecord(inner) && !isReplayOrSynthetic(inner)
    && inner.type === "message" && inner.role === "assistant" && observationId(inner.id)
    && typeof inner.model === "string" && inner.model.trim().length > 0
    && !inner.model.includes("<") && !inner.model.includes(">") && Array.isArray(inner.content)
}

function isResponseBlock(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "text": return typeof value.text === "string"
    case "thinking": return typeof value.thinking === "string" && typeof value.signature === "string"
    case "redacted_thinking": return typeof value.data === "string"
    case "tool_use":
    case "server_tool_use": return observationId(value.id) && observationId(value.name) && isRecord(value.input)
    default: return false
  }
}

function assistantText(message: Record<string, unknown>): string {
  const inner = message.message
  if (!isRecord(inner) || !Array.isArray(inner.content)) return ""
  return inner.content
    .map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n")
}

/**
 * Read one message of the SDK stream for reachability evidence.
 *
 * This inspects native query messages, never client history or tool output.
 * Null retry statuses, assistant error enums and HTTP-looking strings alone
 * supply no evidence. Synthetic terminal error text can identify a definite
 * failure. A later error result or throw does not count it again.
 * Real starts and nonstream bodies require valid response identities/models.
 * The observer correlates starts and completed content blocks before counting.
 */
export function reachabilityEvidence(message: unknown): ReachabilityEvidence {
  if (!isRecord(message) || isReplayOrSynthetic(message)) return null
  if (message.type === "system" && message.subtype === "api_retry") {
    return answeredOverHttp(message) ? { kind: "reached" } : null
  }
  if (message.type === "stream_event") {
    const event = message.event
    return isRecord(event) && event.type === "message_start" && isRealResponse(event.message)
      && responseIdentity(message, event.message) !== null ? { kind: "reached" } : null
  }
  if (message.type !== "assistant") return null
  const inner = message.message
  if (message.error !== undefined) {
    if (typeof message.error !== "string" || !SDK_ASSISTANT_ERRORS.has(message.error)
      || !isRecord(inner) || isReplayOrSynthetic(inner) || inner.type !== "message"
      || inner.role !== "assistant" || inner.model !== "<synthetic>"
      || !Array.isArray(inner.content) || inner.content.length === 0
      || !inner.content.every(block => isRecord(block) && block.type === "text" && typeof block.text === "string")
      || responseIdentity(message, inner) === null) return null
    const text = assistantText(message)
    const failure = classifyConnectionFailure(text)
    if (failure) return { kind: "failure", failure, terminal: true }
    return null
  }
  return isRealResponse(inner) && responseIdentity(message, inner) !== null
    && Array.isArray(inner.content) && inner.content.length > 0 && inner.content.every(isResponseBlock)
    ? { kind: "reached" } : null
}

export interface ReachabilitySnapshot {
  readonly state: ReachabilityState
  /** When the current state began. */
  readonly since: string
  /** First connection failure since this instance last observed an egress answer; null when it
   *  answered most recently. */
  readonly failingSince: string | null
  readonly consecutiveFailures: number
  readonly lastReachedAt: string | null
  readonly lastFailureAt: string | null
  readonly lastErrorKind: ConnectionFailureKind | null
  /** While `unreachable`: when it turns to `probing` absent another failure. */
  readonly holdUntil: string | null
  readonly override: { readonly state: "unreachable" | "ok"; readonly until: string } | null
}

const MAX_DATE_MS = 8_640_000_000_000_000

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function nonNegativeInt(value: unknown, maximum: number = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
}

function environmentInt(value: string | undefined, maximum: number): number | undefined {
  return typeof value === "string" && value.trim() !== "" ? nonNegativeInt(Number(value), maximum) : undefined
}

function normalizeThresholds(value: unknown): ReachabilityThresholds {
  const record = isRecord(value) ? value : {}
  return {
    unreachableAfterMs: nonNegativeInt(record.unreachableAfterMs, MAX_DATE_MS) ?? DEFAULT_REACHABILITY_THRESHOLDS.unreachableAfterMs,
    holdMs: nonNegativeInt(record.holdMs, MAX_DATE_MS) ?? DEFAULT_REACHABILITY_THRESHOLDS.holdMs,
    minFailures: Math.max(1, nonNegativeInt(record.minFailures) ?? DEFAULT_REACHABILITY_THRESHOLDS.minFailures),
  }
}

/** Date-range saturation also keeps every returned timestamp a safe integer. */
function addDuration(timestamp: number, duration: number): number {
  return Math.min(MAX_DATE_MS, timestamp + duration)
}

/**
 * Normalize captured configuration values without reading their sources.
 * Environment values take precedence over persisted numeric settings.
 * A value that is not a non-negative integer is ignored rather than guessed at,
 * and a run always needs at least one failure.
 */
export function reachabilityThresholdsFromConfiguration(
  environment: { readonly unreachableAfterMs?: string; readonly holdMs?: string; readonly minFailures?: string },
  settingsValue: unknown,
): ReachabilityThresholds {
  const settings = isRecord(settingsValue) ? settingsValue : {}
  const pick = (environmentValue: string | undefined, settingKey: string, fallback: number, maximum: number) =>
    environmentInt(environmentValue, maximum) ?? nonNegativeInt(settings[settingKey], maximum) ?? fallback
  return {
    unreachableAfterMs: pick(environment.unreachableAfterMs, "upstreamUnreachableAfterMs", DEFAULT_REACHABILITY_THRESHOLDS.unreachableAfterMs, MAX_DATE_MS),
    holdMs: pick(environment.holdMs, "upstreamUnreachableHoldMs", DEFAULT_REACHABILITY_THRESHOLDS.holdMs, MAX_DATE_MS),
    minFailures: Math.max(1, pick(environment.minFailures, "upstreamUnreachableMinFailures", DEFAULT_REACHABILITY_THRESHOLDS.minFailures, Number.MAX_SAFE_INTEGER)),
  }
}

/**
 * One upstream's reachability. Every timestamp comes from the injected clock,
 * so the state machine is testable without waiting minutes.
 */
export class UpstreamReachability {
  private lastReachedAt: number | null = null
  private lastFailureAt: number | null = null
  private lastErrorKind: ConnectionFailureKind | null = null
  private failingSince: number | null = null
  private consecutiveFailures = 0
  /** When the current unreachable episode began; null outside one. */
  private unreachableSince: number | null = null
  private okSince: number
  private lastClockAt = 0
  private forced: { state: "unreachable" | "ok"; since: number; until: number } | null = null
  private resumed: { state: ReachabilityState; since: number; naturalSince: number } | null = null

  constructor(
    private clock: () => number = Date.now,
    private thresholds: () => ReachabilityThresholds = () => DEFAULT_REACHABILITY_THRESHOLDS,
  ) {
    this.okSince = this.now()
  }

  private now(): number {
    const value = this.clock()
    if (Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS) this.lastClockAt = Math.trunc(value)
    return this.lastClockAt
  }

  private naturalState(now: number, holdMs: number): { state: ReachabilityState; since: number; holdUntil: number | null } {
    if (this.unreachableSince === null || this.lastFailureAt === null) return { state: "ok", since: this.okSince, holdUntil: null }
    const holdEnds = addDuration(this.lastFailureAt, holdMs)
    return now >= holdEnds
      ? { state: "probing", since: Math.max(holdEnds, this.unreachableSince), holdUntil: null }
      : { state: "unreachable", since: this.unreachableSince, holdUntil: holdEnds }
  }

  private expireOverride(now: number, holdMs: number): void {
    const forced = this.forced
    if (!forced || forced.until > now) return
    const natural = this.naturalState(now, holdMs)
    this.resumed = {
      state: natural.state,
      since: forced.state === natural.state && natural.since <= forced.until
        ? forced.since : Math.max(forced.until, natural.since),
      naturalSince: natural.since,
    }
    this.forced = null
  }

  /** A qualifying configured-egress answer returns any state to `ok` at once. */
  recordReached(): void {
    const now = this.now()
    this.expireOverride(now, normalizeThresholds(this.thresholds()).holdMs)
    if (this.failingSince !== null) this.okSince = now
    this.lastReachedAt = now
    this.failingSince = null
    this.consecutiveFailures = 0
    this.unreachableSince = null
  }

  recordFailure(kind: ConnectionFailureKind): void {
    const now = this.now()
    const { unreachableAfterMs, holdMs, minFailures } = normalizeThresholds(this.thresholds())
    this.expireOverride(now, holdMs)
    const wasProbing = this.unreachableSince !== null
      && this.lastFailureAt !== null
      && now - this.lastFailureAt >= holdMs
    this.lastFailureAt = now
    this.lastErrorKind = kind
    this.failingSince ??= now
    this.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.consecutiveFailures + 1)
    if (this.unreachableSince !== null) {
      // Still failing after the hold let traffic back in: the probe answered,
      // so the state flips back now rather than after another detection window.
      if (wasProbing) this.unreachableSince = now
      return
    }
    if (this.consecutiveFailures >= minFailures && now - this.failingSince >= unreachableAfterMs) {
      this.unreachableSince = now
    }
  }

  /** Force a state for testing a load balancer, for at most `ttlMs`. */
  force(state: "unreachable" | "ok", ttlMs: number = DEFAULT_OVERRIDE_TTL_MS): void {
    const now = this.now()
    const ttl = nonNegativeInt(ttlMs, MAX_OVERRIDE_TTL_MS)
    this.forced = { state, since: now, until: addDuration(now, ttl && ttl > 0 ? ttl : DEFAULT_OVERRIDE_TTL_MS) }
    this.resumed = null
  }

  clearOverride(): void {
    const now = this.now()
    const { holdMs } = normalizeThresholds(this.thresholds())
    this.expireOverride(now, holdMs)
    if (!this.forced) return
    const natural = this.naturalState(now, holdMs)
    this.resumed = { state: natural.state, since: natural.state === this.forced.state ? this.forced.since : now, naturalSince: natural.since }
    this.forced = null
  }

  snapshot(): ReachabilitySnapshot {
    const now = this.now()
    const { holdMs } = normalizeThresholds(this.thresholds())
    this.expireOverride(now, holdMs)
    const natural = this.naturalState(now, holdMs)
    if (this.resumed && (this.resumed.state !== natural.state || this.resumed.naturalSince !== natural.since)) {
      this.resumed = null
    }
    const state = this.forced?.state ?? natural.state
    const since = this.forced?.since ?? this.resumed?.since ?? natural.since
    return {
      state,
      since: iso(since)!,
      failingSince: iso(this.failingSince),
      consecutiveFailures: this.consecutiveFailures,
      lastReachedAt: iso(this.lastReachedAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastErrorKind: this.lastErrorKind,
      holdUntil: this.forced ? null : iso(natural.holdUntil),
      override: this.forced ? { state: this.forced.state, until: iso(this.forced.until)! } : null,
    }
  }

  /** Test seam: a fresh tracker on another clock and thresholds. */
  resetForTests(clock: () => number = Date.now, thresholds: () => ReachabilityThresholds = () => DEFAULT_REACHABILITY_THRESHOLDS): void {
    this.clock = clock
    this.thresholds = thresholds
    this.lastReachedAt = null
    this.lastFailureAt = null
    this.lastErrorKind = null
    this.failingSince = null
    this.consecutiveFailures = 0
    this.unreachableSince = null
    this.lastClockAt = 0
    this.okSince = this.now()
    this.forced = null
    this.resumed = null
  }
}

/**
 * One SDK query's view of the tracker. The CLI reports a terminal connection
 * failure twice - as an assistant error message and again as the thrown error
 * that ends the attempt - so the thrown one is counted only when the message
 * never arrived.
 */
export interface ReachabilityObservationOptions {
  /** Must match this query's actual SDK option. With partials enabled, an
   *  unmatched assistant body cannot establish a fresh response start. */
  readonly includePartialMessages?: boolean
}

export function observeReachability(tracker: UpstreamReachability, options: ReachabilityObservationOptions = {}) {
  let terminalRecorded = false
  const responseIds = new Set<string>()
  const failureIds = new Set<string>()
  const claim = (identities: Set<string>, identity: string): boolean => {
    // Do not evict old IDs: a late block/replay must never become fresh proof.
    if (identities.has(identity) || identities.size >= MAX_RESPONSE_IDENTITIES) return false
    identities.add(identity)
    return true
  }
  return {
    message(message: unknown): void {
      const evidence = reachabilityEvidence(message)
      if (!evidence || !isRecord(message)) return
      if (evidence.kind === "reached") {
        let identity: string | null = null
        if (message.type === "system") {
          identity = observationId(message.uuid) ? `http:${message.uuid}`
            : `http:${message.error_status}:${nonNegativeInt(message.attempt) ?? "unknown"}`
        } else if (message.type === "stream_event" && isRecord(message.event) && isRecord(message.event.message)) {
          identity = responseIdentity(message, message.event.message)
        } else if (message.type === "assistant" && isRecord(message.message)) {
          if (options.includePartialMessages) return
          identity = responseIdentity(message, message.message)
        }
        if (identity === null || !claim(responseIds, identity)) return
        tracker.recordReached()
        return
      }
      if (!isRecord(message.message)) return
      const identity = responseIdentity(message, message.message)
      if (identity === null || !claim(failureIds, identity)) return
      if (evidence.terminal) terminalRecorded = true
      tracker.recordFailure(evidence.failure)
    },
    error(error: unknown): void {
      // The thrown report has no response/attempt identity. Once a native
      // terminal envelope arrived, a later throw may be its duplicate even
      // after recovery. Only a distinct identified terminal can prove a new
      // failure in this query; otherwise leave the qualifying answer intact.
      if (terminalRecorded) return
      const text = error instanceof Error ? error.message : typeof error === "string" ? error : null
      const failure = classifyConnectionFailure(text)
      if (failure) tracker.recordFailure(failure)
    },
  }
}

/** Pass an SDK stream through unchanged while the tracker reads it. */
export async function* withReachability<T>(source: AsyncIterable<T>, tracker: UpstreamReachability, options: ReachabilityObservationOptions = {}): AsyncGenerator<T> {
  const observer = observeReachability(tracker, options)
  try {
    for await (const message of source) {
      observer.message(message)
      yield message
    }
  } catch (error) {
    observer.error(error)
    throw error
  }
}

/** The readiness line for an unreachable upstream; null when it may serve. */
export function unreachableDetail(snapshot: ReachabilitySnapshot): string | null {
  if (snapshot.state !== "unreachable") return null
  if (snapshot.override?.state === "unreachable") return `This instance's configured Claude egress forced unreachable by override until ${snapshot.override.until}`
  const failures = `${snapshot.consecutiveFailures} connection failure${snapshot.consecutiveFailures === 1 ? "" : "s"}`
  return `This instance's configured Claude egress failed since ${snapshot.failingSince ?? snapshot.since} (last error: ${snapshot.lastErrorKind ?? "connection"}, ${failures}, last answered ${snapshot.lastReachedAt ?? "never"})`
}
