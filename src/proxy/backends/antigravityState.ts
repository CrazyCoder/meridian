import Database from 'libsql'
import { chmodSync, mkdirSync, lstatSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Meridian-owned state only. Never opens agy's credentials or native transcripts. */
export class AgState {
  private closed = false
  private connection?: Database.Database
  private unlock?: () => void
  private get db(): Database.Database {
    if (!this.connection) throw new Error('Antigravity state is closed')
    return this.connection
  }
  constructor(path: string) {
    path = resolve(path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { const fd = openSync(path, 'wx', 0o600); closeSync(fd) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Antigravity state path must be a regular file')
    chmodSync(path, 0o600)
    this.unlock = lockState(path + '.lock')
    let opened: Database.Database | undefined
    try {
    this.connection = opened = new Database(path)
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('secure_delete = ON')
    this.db.exec('CREATE TABLE IF NOT EXISTS ag_state (kind TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, json TEXT NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS ag_state_expiry ON ag_state(expires)')
    this.prune()
    } catch (error) { try { opened?.close() } finally { this.unlock?.() }; throw error }
  }
  private prune() { this.db.prepare('DELETE FROM ag_state WHERE expires <= ?').run(Date.now()) }
  put(kind: string, id: string, scope: string, json: string, expires: number, maxEntries: number, maxBytes: number) {
    const bytes = Buffer.byteLength(json)
    if (bytes > maxBytes) throw new Error('Antigravity durable state entry exceeds its budget')
    this.db.transaction(() => {
      this.prune()
      this.db.prepare('INSERT OR REPLACE INTO ag_state VALUES (?, ?, ?, ?, ?, ?)').run(kind, id, scope, json, bytes, expires)
      const rows = this.db.prepare('SELECT id, bytes FROM ag_state WHERE kind = ? ORDER BY rowid DESC').all(kind) as Array<{ id: string; bytes: number }>
      let total = 0
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!
        total += row.bytes
        if (index >= maxEntries || total > maxBytes) this.db.prepare('DELETE FROM ag_state WHERE kind = ? AND id = ?').run(kind, row.id)
      }
    }).immediate()
  }
  get(kind: string, id: string, scope: string): string | undefined {
    this.prune()
    return (this.db.prepare('SELECT json FROM ag_state WHERE kind = ? AND id = ? AND scope = ?').get(kind, id, scope) as { json: string } | undefined)?.json
  }
  take(kind: string, id: string, scope: string): string | undefined {
    return this.db.transaction(() => { const value = this.get(kind, id, scope); if (value) this.delete(kind, id, scope); return value }).immediate()
  }
  list(kind: string): string[] {
    this.prune()
    return (this.db.prepare('SELECT json FROM ag_state WHERE kind = ? ORDER BY rowid DESC').all(kind) as Array<{ json: string }>).map(row => row.json)
  }
  records(kind: string): Array<{ id: string; scope: string; bytes: number; expires: number }> {
    this.prune()
    return this.db.prepare('SELECT id, scope, bytes, expires FROM ag_state WHERE kind = ? ORDER BY rowid ASC').all(kind) as Array<{ id: string; scope: string; bytes: number; expires: number }>
  }
  delete(kind: string, id: string, scope: string) { this.db.prepare('DELETE FROM ag_state WHERE kind = ? AND id = ? AND scope = ?').run(kind, id, scope) }
  close() {
    if (this.closed) return
    this.closed = true
    // libsql 0.5.x close drops the connection but its native database wrapper
    // retains resources until collected. Do not keep that wrapper or the guard
    // closure alive merely because a stopped service still references AgState.
    const database = this.connection, unlock = this.unlock
    this.connection = undefined; this.unlock = undefined
    try { database?.close() } finally { unlock?.() }
  }
}

function lockState(path: string): () => void {
  try { const fd = openSync(path, 'wx', 0o600); closeSync(fd) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Antigravity state lock')
  chmodSync(path, 0o600)
  // A separate SQLite guard holds an OS-backed exclusive lock for the service's
  // lifetime. Process death releases it; no PID-file stale-owner race is needed.
  const guard = new Database(path)
  try { guard.pragma('busy_timeout = 0'); guard.exec('BEGIN EXCLUSIVE') }
  catch (error) { guard.close(); throw new Error('Antigravity state is already owned or unavailable; use a separate statePath for each service: ' + String(error)) }
  return () => { try { guard.exec('ROLLBACK') } finally { guard.close() } }
}
