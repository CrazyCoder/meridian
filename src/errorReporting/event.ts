/**
 * Turning a thrown value into a Sentry event, and an event into the envelope a
 * Sentry-protocol collector (GlitchTip, Sentry) ingests.
 *
 * Pure leaf module: no clock, no network, no filesystem, no imports from the
 * tree. Everything is a function of its arguments.
 *
 * Only what grouping and reading an issue need is sent: the exception chain,
 * its stack frames, the Meridian release and runtime, and how the error
 * surfaced. No environment, no argv, no request, no headers, no breadcrumbs.
 * Those are where credentials live, and a collector that receives them has to
 * be treated as a credential store. Error messages still routinely quote a
 * token (an HTTP client echoing its Authorization header, a URL with a signed
 * query), so every string that leaves goes through `scrubSecrets` first.
 */

export type Mechanism = "onuncaughtexception" | "onunhandledrejection"

export interface SentryFrame {
  readonly filename: string
  readonly abs_path: string
  readonly function: string
  readonly lineno?: number
  readonly colno?: number
  readonly in_app: boolean
}

export interface SentryException {
  readonly type: string
  readonly value: string
  readonly stacktrace?: { readonly frames: readonly SentryFrame[] }
  readonly mechanism: { readonly type: Mechanism; readonly handled: boolean }
}

export interface SentryEvent {
  readonly event_id: string
  readonly timestamp: number
  readonly platform: "node"
  readonly level: "error" | "fatal"
  readonly logger: "meridian"
  readonly release?: string
  readonly environment: "production"
  readonly tags: Readonly<Record<string, string>>
  readonly exception: { readonly values: readonly SentryException[] }
  readonly contexts: { readonly runtime: { readonly name: string; readonly version: string } }
}

const REDACTED = "<redacted>"

/**
 * Token shapes Meridian's own errors can carry, most specific first. Each
 * keeps enough of its surroundings (the key name, the URL scheme and host)
 * that the message still says what went wrong.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWTs: OAuth access/id tokens, Anthropic OAuth tokens.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Anthropic (sk-ant-oat01-..., sk-ant-ort01-..., sk-ant-api03-...) and OpenAI keys.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Google OAuth access and refresh tokens (Antigravity).
  [/\bya29\.[A-Za-z0-9._-]{8,}/g, REDACTED],
  [/\b1\/\/[A-Za-z0-9._-]{16,}/g, REDACTED],
  // GitHub tokens.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // URL query strings: signed URLs, ?access_token=, ?code=, ?key=
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi, `$1?${REDACTED}`],
  // URL userinfo: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, `$1${REDACTED}@`],
  // key=value / "key": "value" pairs whose key names a credential. An
  // Authorization value with a scheme was already handled above.
  [
    /\b((?:access|refresh|id)[_-]?token|client[_-]?secret|api[_-]?key|x-api-key|authorization|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s|<redacted>)[^\s"'&,;}]+/gi,
    `$1$2${REDACTED}`,
  ],
]

/**
 * A long run of mixed letters and digits with no other structure is almost
 * never something a human needs to read in an error message, and is the
 * shape of every opaque token the patterns above do not name. Applied to
 * messages only: stack frame paths legitimately contain long hashes.
 */
const OPAQUE_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g

function looksOpaque(run: string): boolean {
  return /[0-9]/.test(run) && /[A-Za-z]/.test(run) && !run.includes("/")
}

export function scrubSecrets(text: string, options: { readonly opaque?: boolean } = {}): string {
  let scrubbed = text
  for (const [pattern, replacement] of SECRET_PATTERNS) scrubbed = scrubbed.replace(pattern, replacement)
  if (options.opaque !== false) {
    scrubbed = scrubbed.replace(OPAQUE_TOKEN, (run) => (looksOpaque(run) ? REDACTED : run))
  }
  return scrubbed
}

const FRAME = /^\s*at (?:(?:async )?(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/
const MAX_FRAMES = 60
const MAX_VALUE = 2_000
const MAX_CAUSES = 5

/**
 * V8 and Bun both print the innermost call first; Sentry wants the outermost
 * first. A frame inside Meridian's package root and outside `node_modules` is
 * in-app, and its filename is made package-relative so the same line groups
 * the same way from every checkout and every npm install.
 */
export function parseStack(stack: string, packageRoot: string): SentryFrame[] {
  const root = packageRoot.endsWith("/") ? packageRoot : `${packageRoot}/`
  const frames: SentryFrame[] = []
  for (const line of stack.split("\n")) {
    const match = FRAME.exec(line)
    if (!match) continue
    const absPath = scrubSecrets((match[2] ?? "").replace(/^file:\/\//, ""), { opaque: false })
    const inPackage = absPath.startsWith(root)
    const relative = inPackage ? absPath.slice(root.length) : absPath
    frames.push({
      filename: relative,
      abs_path: absPath,
      function: match[1] ? scrubSecrets(match[1], { opaque: false }) : "<anonymous>",
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: inPackage && !relative.includes("node_modules/"),
    })
  }
  return frames.slice(0, MAX_FRAMES).reverse()
}

function truncate(text: string): string {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}...` : text
}

function describe(value: unknown): { type: string; value: string; stack?: string } {
  if (value instanceof Error) {
    return {
      type: truncate(scrubSecrets(value.name || "Error")),
      value: truncate(scrubSecrets(value.message)),
      ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
    }
  }
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  } catch {
    // A circular or throwing value still has a String() form.
    text = String(value)
  }
  return { type: "NonErrorThrown", value: truncate(scrubSecrets(text)) }
}

/** The thrown value and its `cause` chain, outermost cause first as Sentry expects. */
export function exceptionChain(
  thrown: unknown,
  mechanism: Mechanism,
  handled: boolean,
  packageRoot: string,
): SentryException[] {
  const chain: SentryException[] = []
  const seen = new Set<unknown>()
  let current: unknown = thrown
  while (chain.length <= MAX_CAUSES && !seen.has(current)) {
    seen.add(current)
    const described = describe(current)
    const frames = described.stack === undefined ? [] : parseStack(described.stack, packageRoot)
    chain.push({
      type: described.type,
      value: described.value,
      ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      mechanism: { type: mechanism, handled },
    })
    if (!(current instanceof Error) || current.cause === undefined) break
    current = current.cause
  }
  return chain.reverse()
}

export function buildEvent(input: {
  readonly eventId: string
  readonly timestampMs: number
  readonly thrown: unknown
  readonly mechanism: Mechanism
  /** Something else keeps the process alive after this error. */
  readonly handled: boolean
  readonly packageRoot: string
  readonly runtime: { readonly name: string; readonly version: string }
  readonly release?: string
}): SentryEvent {
  return {
    event_id: input.eventId,
    timestamp: input.timestampMs / 1000,
    platform: "node",
    level: input.handled ? "error" : "fatal",
    logger: "meridian",
    ...(input.release !== undefined ? { release: input.release } : {}),
    environment: "production",
    tags: { mechanism: input.mechanism },
    exception: { values: exceptionChain(input.thrown, input.mechanism, input.handled, input.packageRoot) },
    contexts: { runtime: { name: input.runtime.name, version: input.runtime.version } },
  }
}

export interface ParsedDsn {
  readonly envelopeUrl: string
  readonly publicKey: string
}

/** `scheme://key@host[/path]/projectId` -> the envelope endpoint and the key that authorises it. */
export function parseDsn(dsn: string): ParsedDsn | null {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  const segments = url.pathname.split("/").filter((segment) => segment !== "")
  const projectId = segments.pop()
  if (url.username === "" || projectId === undefined || !/^\d+$/.test(projectId)) return null
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : ""
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: decodeURIComponent(url.username),
  }
}

/**
 * No `sent_at`: envelopes are built when the error happens but may be posted
 * days later from the spool, and a collector corrects the event timestamp by
 * the gap between `sent_at` and arrival.
 */
export function buildEnvelope(event: SentryEvent): string {
  const header = { event_id: event.event_id }
  const payload = JSON.stringify(event)
  const item = { type: "event", content_type: "application/json", length: Buffer.byteLength(payload) }
  return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${payload}\n`
}

export function authHeader(publicKey: string, client: string): string {
  return `Sentry sentry_version=7, sentry_client=${client}, sentry_key=${publicKey}`
}
