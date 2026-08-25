/**
 * Shared reader for the session JSONL the CLI writes behind Meridian.
 *
 * The passthrough probes all answer the same question — what would
 * resumeSessionAt keep? — so they read the transcript the same way. One copy,
 * because three drifted: two matched only "forwarded to the client" while a
 * third also matched "was NOT executed", which silently changes what each
 * reports as a denial.
 *
 * Deny detection is STRUCTURAL, not prose. The reason text lives in server.ts
 * and is edited freely; a probe keyed on it reports "0 denials surviving —
 * clean" the moment the wording moves, which is a green meaning "detection
 * broke" on exactly the thing these probes exist to catch. In a passthrough
 * transcript every tool_result the CLI writes for a forwarded call is the
 * synthetic denial (the client's real results are injected on the next request
 * and carry no is_error), so `is_error === true` identifies it without knowing
 * a single word of the reason.
 *
 * DENY_TEXT_MARKER stays only as a drift signal: callers can report whether the
 * prose still matches, so a wording change is visible rather than silent.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Current phrasing of the forwarded-call denial. A cross-check, never a test. */
export const DENY_TEXT_MARKER = "forwarded to the client"

const PROJECTS_ROOT = join(homedir(), ".claude", "projects")

/** Locate the session JSONL the CLI wrote for a session id, whatever the cwd slug. */
export function findSessionFile(sessionId) {
  if (!existsSync(PROJECTS_ROOT)) return null
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const candidate = join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every session JSONL on disk with its mtime, for before/after diffing. */
export function snapshotSessionFiles() {
  const seen = new Map()
  if (!existsSync(PROJECTS_ROOT)) return seen
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const full = join(PROJECTS_ROOT, dir)
    let entries
    try { entries = readdirSync(full) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue
      const p = join(full, f)
      try { seen.set(p, statSync(p).mtimeMs) } catch { /* raced with a write */ }
    }
  }
  return seen
}

export function readRows(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

export const blocksOf = row => (Array.isArray(row?.message?.content) ? row.message.content : [])

/** Flatten a tool_result's content to text, whichever shape it arrived in. */
export function toolResultText(block) {
  if (typeof block?.content === "string") return block.content
  if (Array.isArray(block?.content)) return block.content.map(c => c?.text ?? "").join("")
  return ""
}

/** A synthetic denial: the CLI's answer to a call the hook refused. */
export function isDenyResult(block) {
  return block?.type === "tool_result" && block.is_error === true
}

/** Does the denial still read the way the probes' commentary claims? */
export function denyTextMatchesMarker(block) {
  return toolResultText(block).includes(DENY_TEXT_MARKER)
}

/**
 * Guard against a silent detection failure: a turn that forwarded calls must
 * have produced denials, so finding none means the reader is broken, not that
 * the transcript is clean. Returns a warning string, or null when all is well.
 */
export function denyDetectionWarning({ forwardedCalls, denyResults }) {
  if (forwardedCalls === 0 || denyResults.length > 0) {
    const drifted = denyResults.length > 0 && !denyResults.some(denyTextMatchesMarker)
    return drifted
      ? `deny wording no longer contains ${JSON.stringify(DENY_TEXT_MARKER)} — update DENY_TEXT_MARKER (detection itself is structural and still correct)`
      : null
  }
  return `${forwardedCalls} call(s) were forwarded but NO deny tool_result was found — ` +
    `treat every "clean" result below as unproven; the reader, not the transcript, is probably wrong`
}
