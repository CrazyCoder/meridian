# Asynchronous SDK process gate (#1221)

Accept with correction. Source `c81959314dc2aa58802322913b69caa749e2c0b8`
was cherry-picked with Nowaker Author/AuthorDate intact. Integration rebased
onto `c0af34eaafefdd454fca1252ed5b9ae1b1f13e8f` after #1235 landed.

Each SDK launch previously fsynced its environment-bearing gate file and
parent synchronously, blocking all proxy HTTP and stream processing. The
authored change uses asynchronous file operations while its already-gated
wrapper waits for the atomic publication. Process identity is persisted before
execution, failures terminate the wrapper, and abort/join behavior stays fenced.

## Adversarial finding and correction

The authored `closeAndJoin(timeout)` waited on publication without a timeout
after observing child exit. A held disk operation could therefore block
shutdown indefinitely. The new regression fails on the authored implementation
(receives `unbounded` rather than false). The maintainer correction shares one
deadline across process exit/termination and publication, returns false while
publication remains pending, and removes late sensitive files only after both
publication and process exit. Callers retain the fail-closed lease when join
returns false. A later settled join can succeed.

Eight direct gate tests / 25 assertions pass: exact process attachment, large
stderr drainage, pre-abort refusal, responsive event loop during fsync,
abort-during-write cleanup, bounded pending publication and injected sync
failure. The new timeout regression is a failing-before/passing-after control.
Publication errors after atomic rename can race an already-started wrapper;
no general claim that every directory-flush failure precedes execution is made.

## Actual client proof (2026-10-02)

Committed harness: `scripts/e2e-sdk-gate-client.mjs`. Actual OpenCode 1.18.34,
Agent SDK 0.2.141, Claude Code 2.1.284, independently installed scrub 0.2.3,
Bun 1.3.11, upstream-confirmed `claude-opus-5-5`. It holds ONLY actual SDK
gate file-handle fsyncs asynchronously for 200 ms; real query methods, child
processes and upstream generation remain intact. During four gate holds:

| Platform | Successful liveness probes during held fsync | Failed probes | Client/tool/resume |
| --- | ---: | ---: | --- |
| macOS arm64 | 69 | 0 | pass |
| Linux arm64, Docker | 47 | 0 | pass |

Both runs exit zero, use four real SDK queries, read a unique client-tool
receipt and recall it on the same resumed session. All queries use the owned
isolated native credential directory. The Linux container used a private
access-only copy, not a refresh token, and provisioned its own machine ID for
normal fail-closed process identity capture. No missing-identity override used.
The container was removed after verification. The source production host's
exact encrypted filesystem/journal load and x86 architecture were not
reproduced; the deterministic held-fsync proof establishes the event-loop
behavior, not a claimed production outage-rate reduction.

All four E41 chain/parallel × JSON/stream probes pass on macOS with actual Opus
5.5, SDK 0.2.141 and CLI 2.1.284: exact real-answer pairing in supported SDK
history, durable fork continuity and cache-prefix reads. No private SDK
transcript files are inspected or changed.

Explained harness failures: the first liveness assertion expected `ok` rather
than the documented `ok\n`; all actual client receipts/resume already passed,
and the corrected assertion trims the newline. The initial Linux fixture lacked
`/etc/machine-id` and startup correctly refused it; provisioning the container's
own native identity resolved that setup requirement. Neither is claimed as a
product regression or an unexplained green rerun.

Final local checks on the rebased integration: npm test 5,120 pass / zero
failures / four skips; standalone typecheck and build pass. Required exact-head
CI remains a merge gate. No release.

## Reproduction

Build, then on macOS or Linux with an owned native credential directory:

```sh
E2E_PROFILE_CLAUDE_DIR=/owned/claude-config \
E2E_PLUGIN_PATH=/owned/independently-installed-scrub/dist/index.js \
E2E_CLAUDE_BIN=/owned/claude-executable \
npm exec --yes --package=bun@1.3.11 -- bun scripts/e2e-sdk-gate-client.mjs
```

The proxy, client and project use isolated state and a random loopback port.
Only sanitized assertion summaries print; raw client artifacts stay private.
Use E41's documented commands for its four modes. The committed tests and
harness plus this record escrow the proof beyond temporary logs.
