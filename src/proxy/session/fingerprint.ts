/**
 * Conversation fingerprinting, client working directory extraction, and
 * embedded session-identifier extraction. All functions here are pure.
 *
 * NOTE: extractClientCwd is OpenCode-specific (parses <env> blocks).
 * When the adapter pattern is implemented, this will move to the
 * OpenCode adapter. getConversationFingerprint, getSystemPromptText and
 * extractEmbeddedSessionId are agent-agnostic.
 */

import { createHash } from "crypto"

/**
 * Extract the client's working directory from the system prompt.
 * OpenCode embeds it inside an <env> block:
 *   <env>
 *     Working directory: /path/to/project
 *     ...
 *   </env>
 *
 * Returns the path if found, or undefined to fall back to server defaults.
 */
export function extractClientCwd(body: any): string | undefined {
  const systemText = getSystemPromptText(body)
  if (!systemText) return undefined

  const match = systemText.match(/<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i)
  return match?.[1]?.trim() || undefined
}

/**
 * Flatten the request's system prompt to a single string.
 * `system` may be a bare string or an array of content blocks.
 */
export function getSystemPromptText(body: any): string {
  if (typeof body?.system === "string") return body.system
  if (Array.isArray(body?.system)) {
    return body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  return ""
}

/**
 * Runtime descriptor line that some clients embed in their system prompt to
 * tell the model about the environment it is running in, e.g.
 *
 *   Runtime: agent=<name> | session=<key> | sessionId=<id> | host=<host> | ...
 *
 * The identifier is stable for the lifetime of one conversation.
 *
 * Requires an alphanumeric first character and at least 8 characters overall.
 * That is deliberately a junk filter rather than a format check: a placeholder
 * like `sessionId=unknown` must NOT match, because keying every conversation
 * to one shared bucket is worse than having no key at all.
 */
export const EMBEDDED_SESSION_PATTERN = /^Runtime:.*?\bsessionId=([A-Za-z0-9][\w-]{7,})/m

/**
 * Extract a stable conversation identifier embedded in the system prompt.
 *
 * Clients that send no session header at all otherwise fall back to the
 * (first user message, working directory) conversation fingerprint, which
 * collides whenever two conversations open with the same text in the same
 * directory — one conversation then resumes another's session. An identifier
 * the client already publishes is an exact key, so prefer it when present.
 *
 * Pure: returns undefined when the request carries no such marker, which
 * leaves fingerprint behavior for every other client unchanged.
 */
export function extractEmbeddedSessionId(
  body: any,
  pattern: RegExp = EMBEDDED_SESSION_PATTERN,
): string | undefined {
  const systemText = getSystemPromptText(body)
  if (!systemText) return undefined
  return systemText.match(pattern)?.[1]?.trim() || undefined
}

/**
 * Hash the first user message + working directory to fingerprint a conversation.
 * Used to find a cached session when no session header is present.
 * Includes workingDirectory (stable per project, unlike systemContext which
 * contains dynamic file trees/diagnostics that change every request).
 * This prevents cross-project collisions when different projects start
 * with the same first message.
 */
export function getConversationFingerprint(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  const firstUser = messages?.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
  if (!text) return ""
  const seed = workingDirectory ? `${workingDirectory}\n${text.slice(0, 2000)}` : text.slice(0, 2000)
  return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}
