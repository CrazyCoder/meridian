/**
 * File-based session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. This stores session
 * mappings in a JSON file that all proxy instances read/write.
 *
 * Format: { [key]: { claudeSessionId, createdAt, lastUsedAt } }
 * Keys are either OpenCode session IDs or conversation fingerprints.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"

export interface StoredSession {
  claudeSessionId: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function getStorePath(): string {
  const dir = process.env.CLAUDE_PROXY_SESSION_DIR
    || join(homedir(), ".cache", "opencode-claude-max-proxy")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, "sessions.json")
}

function readStore(): Record<string, StoredSession> {
  const path = getStorePath()
  if (!existsSync(path)) return {}
  try {
    const data = readFileSync(path, "utf-8")
    const store = JSON.parse(data) as Record<string, StoredSession>
    // Prune expired entries
    const now = Date.now()
    const pruned: Record<string, StoredSession> = {}
    for (const [key, session] of Object.entries(store)) {
      if (now - session.lastUsedAt < SESSION_TTL_MS) {
        pruned[key] = session
      }
    }
    return pruned
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, StoredSession>): void {
  const path = getStorePath()
  const tmp = path + ".tmp"
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2))
    renameSync(tmp, path) // atomic write
  } catch {
    // If rename fails, try direct write
    try {
      writeFileSync(path, JSON.stringify(store, null, 2))
    } catch {}
  }
}

export function lookupSharedSession(key: string): StoredSession | undefined {
  const store = readStore()
  const session = store[key]
  if (!session) return undefined
  if (Date.now() - session.lastUsedAt >= SESSION_TTL_MS) return undefined
  return session
}

export function storeSharedSession(key: string, claudeSessionId: string, messageCount?: number): void {
  const store = readStore()
  const existing = store[key]
  store[key] = {
    claudeSessionId,
    createdAt: existing?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    messageCount: messageCount ?? existing?.messageCount ?? 0,
  }
  writeStore(store)
}

export function clearSharedSessions(): void {
  const path = getStorePath()
  try {
    writeFileSync(path, "{}")
  } catch {}
}
