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
 * Such clients do describe the conversation in the system prompt, so the model
 * knows what it is working on, and that description is enough to key on with no
 * client-side change. Two forms are recognised: an identifier for the
 * conversation itself, and — when the client publishes no identifier — the
 * block describing where the conversation is happening.
 *
 * Behavior otherwise matches the OpenCode adapter, and `baseName` keeps it
 * resolving as such, so transforms, plugin scoping, and name-keyed branches in
 * the proxy behave exactly as they did before this adapter existed. Only
 * session identification differs.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { extractEmbeddedSessionId, extractSessionContextKey } from "../session/fingerprint"
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

/**
 * Namespace for keys derived from a per-conversation context block. The two
 * derived spaces can never name the same key: reaching this one would take an
 * identifier beginning `ctx:`, and the identifier pattern admits no colon.
 */
export const SESSION_CONTEXT_KEY_PREFIX = "custom:ctx:"

/**
 * Derive this adapter's session key from the request body.
 *
 * Preference order — most selective first:
 *   1. an identifier the client publishes for the conversation itself;
 *   2. a hash of the block describing where the conversation is happening.
 *
 * Detection and keying share this function on purpose: an adapter that is
 * selected but then produces no key would be routed straight back onto the
 * fingerprint path it exists to avoid.
 */
export function deriveSystemPromptSessionKey(body: unknown): string | undefined {
  const embedded = extractEmbeddedSessionId(body)
  if (embedded) return `${EMBEDDED_SESSION_KEY_PREFIX}${embedded}`

  const context = extractSessionContextKey(body)
  return context ? `${SESSION_CONTEXT_KEY_PREFIX}${context}` : undefined
}

export const customAdapter: AgentAdapter = {
  ...openCodeAdapter,
  name: "custom",
  baseName: openCodeAdapter.name,

  getSessionId(c: Context, body?: unknown): string | undefined {
    // An explicit header still wins when one is present, and keeps its own
    // key space — it is already unique to the client that sent it.
    const header = openCodeAdapter.getSessionId(c, body)
    if (header) return header

    return deriveSystemPromptSessionKey(body)
  },
}

/**
 * The last detection rule in detect.ts, ahead of only the default adapter:
 * a headerless client that describes its conversation in the system prompt.
 * Every explicit signal keeps priority, and it applies only when the body is
 * available — callers that detect before parsing get the header-only result.
 *
 * Kept here, not in detect.ts, so the fork's footprint in that upstream file
 * stays at a few isolated lines.
 */
export function detectCustomAdapter(body: unknown): AgentAdapter | undefined {
  return body !== undefined && deriveSystemPromptSessionKey(body) ? customAdapter : undefined
}
