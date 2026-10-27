---
id: session
type: module-design
status: active
title: Sessions, lineage and bookkeeping
parent: architecture
depends-on: [telemetry-ui]
---

## Responsibility

Map each client conversation to a Claude SDK session and decide, per request,
whether the incoming history can **resume**, **fork** or must **replay**:

- lineage verification (continuation / compaction / undo / diverged) over
  structured v2 hashes;
- the in-memory session and fingerprint LRUs and the durable shared store that
  lets another proxy process resume the same conversation;
- turn serialization (in-process and cross-process), transcript publication
  leases and transcript garbage collection;
- the optional SQLite bookkeeping backend (`bookkeeping/`) and its offline
  `meridian-bookkeeping` maintenance CLI.

Code: `src/proxy/session/`, plus `sessionStore.ts`, `sessionLifecycle.ts` and
`executionHistory.ts` beside it.

## Boundary

- `lineage.ts` is **pure**: hashing and comparison only — no I/O, caches or
  server/cache imports; testable without mocks.
- `cache.ts` **owns all mutable session state**; no other module creates
  session LRUs.
- Never imports `server.ts`, adapters or provider backends. It may use the
  leaf `messages.ts`, `utils/lruMap.ts` and telemetry diagnostics.
- Lineage proof is the **original client history**; plugin-modified execution
  history may change what the SDK runs but never proves a resume.
- When it cannot prove the SDK session contains a section of client history,
  it starts fresh and replays — it never silently skips history.
- The Antigravity backend never uses this module; the ChatGPT backend reuses
  only its durability primitives (`durableFileSystem`, `processIncarnation`,
  `recoveryClaim`).
- JSON bookkeeping is the default; `MERIDIAN_BOOKKEEPING=sqlite` is explicit and
  a SQLite directory never falls back to JSON.
- A prompt-cache keepalive beat (see `proxy-core` → Decisions) only **reads**
  a published mapping: it resumes the mapping's current transcript as a
  non-persisted fork, takes no writer or publication lease, and never
  publishes, invalidates or reclassifies anything. The session's mapping,
  transcript and lineage are byte-identical before and after a beat. The
  source transcript is pinned against this process's GC until the beat's
  child is joined; collectors in other processes ignore that private pin, but
  the published mapping retains the source, and if another process retires it
  anyway the beat only fails and is retried or stopped.
- Transcript GC here is the only Meridian-owned transcript deletion. Opt-in
  transcript retention (`proxy/transcriptRetention.ts`, off by default) hands
  Claude Code's own cleanup a period; that cleanup is outside this module's
  leases and pins and may retire a mapped transcript by age, after which the
  conversation replays (see `architecture` → *Transcript publication
  lifetime*).

Detailed contracts live in [`architecture`](../../../ARCHITECTURE.md): *Session
Management*, *Lineage Verification*, *SQLite bookkeeping boundary*, *Transcript
publication lifetime*, *Session store write cost*, *Lineage hash encoding* and
*Appended content and transient hooks*.

## Known limitations

- **Container host identity.** Inside containers the derived `hostId` changes on
  restart, and containers built from one image share a baked `machine-id`, so
  stale or foreign store locks can wedge requests. Workaround:
  `MERIDIAN_HOST_ID` (see `docs/configuration.md` → *Known limitations*).
- **Boot identity is required.** Without a host boot identity Meridian refuses
  to start (escape hatch `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY=1` still cannot
  serve).
- **Mixed proxy versions replay.** v1 lineage digests cannot prove a v2 prefix,
  so alternating old and new proxies repeats a full-history replay until every
  participating proxy is upgraded.
- **Editing a primary agent's instructions without switching agents** stays
  subject to the native resume limitation (the SDK restores its original system
  prompt).
- **A conversation returning to a pruned profile copy replays** instead of
  resuming (only with `MERIDIAN_SESSION_PROFILE_COPY_PRUNE=1`).
- **Windows writer-lease recovery** for a crashed proxy waits for a host reboot,
  because an executor's death does not prove its descendants gone.
- **Retention cleanup can race a resume** (only with opt-in transcript
  retention on). Claude Code's cleanup runs a few seconds after a request
  child starts, in any child sharing the config root, and deletes by mtime
  alone. A conversation idle for longer than the period whose resume is
  loading its transcript while a concurrent cleanup deletes it can lose its
  SDK-side history: the child keeps what it already read but appends to a new
  file without the earlier turns, so a later resume silently lacks them and
  lineage cannot detect it. A conversation
  whose transcript is already gone is refused and replays from client
  history instead. A pin-aware cleanup is a recorded follow-up (`proxy-core`
  → *Decisions*).
