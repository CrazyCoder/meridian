/** Shared hostname consent policy; no dependency on a proxy or provider. */
import { hostname } from "node:os"
import { loadSettings, setSetting } from "./settings"

function hostnameEnabled(): boolean {
  // A malformed or null persisted document must never opt into disclosure.
  return loadSettings()?.showHostname === true
}

export function headerSettingsState() {
  return { showHostname: hostnameEnabled(), hostname: hostname() }
}

/** Read immediately before assembling a health response, after async probes. */
export function healthHostname() {
  return hostnameEnabled() ? { hostname: hostname() } : {}
}

/** Authentication belongs to the caller's existing settings-route boundary. */
export async function headerSettingsResponse(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" }
  if (request.method === "GET") return Response.json(headerSettingsState(), { headers })

  // The optional API key does not prevent a foreign site from opting an
  // unkeyed local server into public disclosure. Browser mutations must come
  // from this server; CLI requests without Origin retain their existing use.
  // Node sees HTTP behind a TLS terminator. Permit its HTTPS public origin
  // only when Host/port match; never trust arbitrary forwarding headers.
  const origin = request.headers.get("origin")
  let permitted = origin === null
  if (origin !== null) {
    try {
      const source = new URL(origin), target = new URL(request.url)
      permitted = source.origin === origin && (source.origin === target.origin
        || (source.protocol === "https:" && target.protocol === "http:" && source.hostname === target.hostname
          && (source.port === target.port || (source.port === "" && target.port === "443"))))
    } catch { permitted = false }
  }
  if (!permitted) {
    return Response.json({ error: "Header settings require a same-origin request" }, { status: 403, headers })
  }
  let input: unknown
  try { input = await request.json() }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }) }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Response.json({ error: "Settings must be a JSON object" }, { status: 400, headers })
  }
  const { showHostname } = input as Record<string, unknown>
  if (showHostname !== undefined) {
    if (showHostname !== null && typeof showHostname !== "boolean") {
      return Response.json({ error: "showHostname must be a boolean, or null to unset" }, { status: 400, headers })
    }
    setSetting("showHostname", showHostname ?? undefined)
  }
  return Response.json(headerSettingsState(), { headers })
}
