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
 * Heading that introduces a per-conversation context block: the section some
 * clients append to the system prompt to tell the model where the conversation
 * is happening and who it is with.
 */
const SESSION_CONTEXT_HEADING = /^#{1,3}[ \t]+Current Session Context[ \t]*$/m

/** Any following heading — marks the end of the block. */
const SESSION_CONTEXT_BLOCK_END = /^#{1,3}[ \t]+\S/m

/**
 * The identity-bearing lines of that block: who the conversation is with and
 * where it is happening.
 *
 * Deliberately an allow-list. The block also carries lines that describe
 * capability rather than identity (connected platforms, delivery targets);
 * those change while the conversation stays the same, and hashing them would
 * throw the session key away for no reason. The `g` flag is safe on a
 * module-level regex here because `matchAll` iterates over a clone and never
 * advances this object's `lastIndex`.
 */
const SESSION_CONTEXT_IDENTITY_LINE =
  /^\*\*(Source|User|User ID|Session type):\*\*[ \t]*(\S.*?)[ \t]*$/gm

/**
 * Derive a stable conversation key from a per-conversation context block in
 * the system prompt.
 *
 * This is the fallback for clients that publish *where* a conversation is
 * happening but no identifier for it. Hashing the identity lines yields a key
 * that is byte-stable for as long as the conversation stays in the same place,
 * and differs across chats, threads, and platforms — far more selective than
 * the (first user message, working directory) fingerprint, which is blind to
 * all of them.
 *
 * It is a chat-scoped key, not a session-scoped one: two conversations that
 * run in the same chat one after another share it. That is safe because
 * `verifyLineage` still has to accept the history before anything resumes — a
 * successor conversation diverges and simply starts a fresh session.
 *
 * Returns undefined unless a `Source` line is present, so a client that
 * happens to use the same heading for something else is left alone.
 *
 * Pure: reads the system prompt only, never message content, so conversation
 * text cannot steer the key.
 */
export function extractSessionContextKey(body: any): string | undefined {
  const systemText = getSystemPromptText(body)
  if (!systemText) return undefined

  const heading = systemText.match(SESSION_CONTEXT_HEADING)
  if (heading?.index === undefined) return undefined

  const afterHeading = systemText.slice(heading.index + heading[0].length)
  const nextHeading = afterHeading.match(SESSION_CONTEXT_BLOCK_END)
  const block = nextHeading?.index === undefined
    ? afterHeading
    : afterHeading.slice(0, nextHeading.index)

  const identity: string[] = []
  let hasSource = false
  for (const [, field, value] of block.matchAll(SESSION_CONTEXT_IDENTITY_LINE)) {
    if (field === "Source") hasSource = true
    identity.push(`${field}:${value}`)
  }
  if (!hasSource) return undefined

  return createHash("sha256").update(identity.join("\n")).digest("hex").slice(0, 16)
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
