# Interactive Claude Code side calls: live before/after (2026-10-14)

Real interactive Claude Code 2.1.299 in a PTY (gate E77,
`scripts/e2e-claude-code-captions-interactive.mjs`), model `sonnet`, macOS
arm64, two Agent-tool subagents each running 40-second commands.

| Request | `main` `0559c554d` ([log](before-main-0559c554d.txt)) | This branch ([log](after-branch.txt)) |
|---|---|---|
| Session title at startup (streamed, no tools, one message) | creates the conversation's mapping | `independent-request:auxiliary-request` |
| First real turn (msgCount 2) | `unrelated-history` after a 2.2 s lease wait | `not-found` (new), 42 ms |
| Each subagent's first caption at 30 s (msgCount 2) | read as a turn: `unrelated-history` | `independent-request:auxiliary-request` |
| Each subagent's next turns (msgCount 5, 8, 11) | `unrelated-history`: full replay each time, one after a 5.3 s lease wait | `continuation` |
| Working requests that diverged | 9 | 0 |

The two request shapes come from the 2.1.299 binary: the session title is
`querySource: "generate_session_title"` (interactive only), and the first caption
fires while the subagent's first tool call is still running, so the client drops
the unresolved tool call and appends the subagent's system-role context as a
trailing `system` message after the caption prompt, which the #1292 detector did
not expect.

Not covered: other Claude Code versions, other platforms, and other tool-free
helper calls (`teleport_generate_title`, `rename_generate_name`,
`tool_use_summary_generation`), which were not observed at startup and are not
matched.
