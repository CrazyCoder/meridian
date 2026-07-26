/**
 * Custom agent adapter — headerless clients that publish a runtime session
 * descriptor in their system prompt.
 *
 * Some clients drive their own tool loop and replay the full conversation on
 * every request, but send no session header of any kind. Without a key they
 * fall back to the (first user message, working directory) conversation
 * fingerprint, which is not unique: two conversations that open with the same
 * text in the same directory collide, and one resumes the other's session.
 * Such clients also never resume at all once the guard for headerless tool
 * loops trips, so their prompt cache decays to the static prefix and the whole
 * history is rewritten every turn.
 *
 * These clients do publish a stable identifier — they put it in the system
 * prompt so the model can report it. Reading that gives an exact per-
 * conversation key with no client-side change.
 *
 * Behavior otherwise matches the OpenCode adapter, and `baseName` keeps it
 * resolving as such, so transforms, plugin scoping, and name-keyed branches in
 * the proxy behave exactly as they did before this adapter existed. Only
 * session identification differs.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { extractEmbeddedSessionId } from "../session/fingerprint"
import { openCodeAdapter } from "./opencode"

/**
 * Namespace for keys derived from the system prompt.
 *
 * Session keys from every client share one space, and the shared session store
 * outlives the process. Header-supplied ids are opaque strings, so without a
 * namespace a short embedded identifier could collide with another client's
 * session id — which is the exact cross-conversation mix-up this adapter exists
 * to prevent. Prefixing makes that structurally impossible.
 */
export const EMBEDDED_SESSION_KEY_PREFIX = "custom:"

export const customAdapter: AgentAdapter = {
  ...openCodeAdapter,
  name: "custom",
  baseName: openCodeAdapter.name,

  getSessionId(c: Context, body?: unknown): string | undefined {
    // An explicit header still wins when one is present, and keeps its own
    // key space — it is already unique to the client that sent it.
    const header = openCodeAdapter.getSessionId(c, body)
    if (header) return header

    const embedded = extractEmbeddedSessionId(body)
    return embedded ? `${EMBEDDED_SESSION_KEY_PREFIX}${embedded}` : undefined
  },
}
