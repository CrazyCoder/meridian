/**
 * Header health pill - what the shared site header says about this instance.
 *
 * Serialized with `.toString()` into the header's inline script, like
 * buildBadge.ts, so it must stay self-contained: no references outside its
 * own body. It takes `unknown` because the browser hands it raw `/health`
 * JSON; a field that is absent or malformed falls back to the plain status.
 *
 * Shutdown and offline status retain authority. Native-Claude transport
 * observations apply only to Claude, including on combined-provider instances.
 */

export interface StatusPillView {
  /** The dot's class: healthy green, degraded yellow, unhealthy red. */
  readonly tone: "healthy" | "degraded" | "unhealthy"
  readonly text: string
  /** Detail text; empty when there is nothing to add to `text`. */
  readonly title: string
  /** Render the whole pill as an alert rather than a calm status line. */
  readonly alert: "outage" | "recovering" | null
}

export function statusPillView(health: unknown): StatusPillView {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }
  function time(value: unknown): string | null {
    if (typeof value !== "string") return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
  }

  if (!isRecord(health)) return { tone: "unhealthy", text: "Offline", title: "", alert: null }
  const tone = health.status === "healthy" ? "healthy" : health.status === "degraded" ? "degraded" : "unhealthy"
  const plain: StatusPillView = {
    tone,
    text: tone === "healthy" ? "Operational" : tone === "degraded" ? "Degraded" : "Offline",
    title: "",
    alert: null,
  }
  if (health.status === "draining") {
    return { tone: "unhealthy", text: "Draining", title: "Meridian is shutting down; route new requests to another instance.", alert: null }
  }
  if (tone === "unhealthy" || health.backend === "antigravity") return plain
  const combined = health.backend === "combined"
  const upstream = isRecord(health.upstream) && isRecord(health.upstream.claude) ? health.upstream.claude : null
  if (!upstream) return plain
  const lastError = typeof upstream.lastErrorKind === "string" && ["dns", "refused", "reset", "unroutable", "timeout", "tls", "proxy", "connection"].includes(upstream.lastErrorKind) ? upstream.lastErrorKind : null
  const lastAnswered = time(upstream.lastReachedAt)

  if (upstream.state === "unreachable") {
    const override = isRecord(upstream.override) ? time(upstream.override.until) : null
    const failures = typeof upstream.consecutiveFailures === "number" && Number.isSafeInteger(upstream.consecutiveFailures) && upstream.consecutiveFailures >= 0 ? upstream.consecutiveFailures : null
    const lines = override
      ? ["This instance's configured Claude egress is forced unreachable by a test override until " + override + "."]
      : [
        "Native Claude traffic from this instance has definite connection failures to its configured egress; load balancers are told to send traffic elsewhere.",
        "Failing since: " + (time(upstream.failingSince) ?? time(upstream.since) ?? "unknown"),
        "Last error: " + (lastError ?? "connection") + (failures !== null ? " (" + failures + " connection failure" + (failures === 1 ? "" : "s") + ")" : ""),
        "Last answered: " + (lastAnswered ?? "never since start"),
      ]
    if (combined) lines.push("Antigravity is independent of this Claude transport observation.")
    const holdUntil = time(upstream.holdUntil)
    if (holdUntil) lines.push("Requests are let back in at " + holdUntil + " unless failures continue.")
    return { tone: "unhealthy", text: "Claude connection failed", title: lines.join("\n"), alert: "outage" }
  }

  if (upstream.state === "probing") {
    return {
      tone: "degraded",
      text: "Rechecking Claude connection",
      title: [
        "This instance's configured Claude egress had definite connection failures" + (lastError ? " (last error: " + lastError + ")" : "") + ".",
        "Requests are let through again; actual native Claude traffic can show recovery.",
        ...(combined ? ["Antigravity is independent of this Claude transport observation."] : []),
        "Last failure: " + (time(upstream.lastFailureAt) ?? "unknown"),
      ].join("\n"),
      alert: "recovering",
    }
  }

  return plain
}
