# #1292 progress captions and side calls: live before/after (2026-10-14)

Contributor PR #1292 by @justprosh, merged as `cbed8faaa` (Author on `main`:
Aleksey Proshutinskiy). Fixes #1288. Maintainer commits on the branch: a merge
of `main` after #1211 and #1231 landed (recorded as the PR's own diff applied to
`main`, checked line-for-line), and `7bc3f87fe`, which updated one test and a
comment because #1349 had since made every query build its own MCP server.

Real interactive Claude Code 2.1.299 in a PTY, model `sonnet`, macOS arm64, two
subagents each running two to three 40-second commands.

| | Unchanged `main` `3e8c36962` ([baseline](baseline-main-3e8c36962.txt)) | PR `7bc3f87fe` ([candidate](candidate-pr-7bc3f87fe.txt)) |
|---|---|---|
| Caption requests (msgCount 7) | read as turns (`continuation` / `unrelated-history`) | `independent-request:auxiliary-request` |
| Each subagent's next turn (msgCount 8) | `modified-history`: full replay | `continuation` |

The escrowed gate (E77, `scripts/e2e-claude-code-captions-interactive.mjs`)
then passed on `main` with #1292 at `0559c554d`
([run](escrowed-gate-main-0559c554d.txt)). The auto-mode gate E71 also passed on
the PR head ([run](e71-auto-mode-pr.txt)), and a variant of E72 passed with subagents kept busy
for 80 seconds in print mode, where no caption is sent.

Local gates on the merged head: `npm test` and `npm run build`, zero failures.
Final-head CI green; merged with `--admin` (unsigned commits were the only
block), explicit `--body`, no maintainer trailer.

## Review

An independent review checked the detection predicates against the 2.1.296
binary: the caption template matches byte for byte, and the tool-less unstreamed
shape also covers the classifier's stage-2 call that #1211 missed (it relies on
the `x-claude-code-session-id` header, so a gateway that strips it falls back to
#1211's stop-sequence rule). Low-severity false positive: the CLI's
non-streaming fallback of a real turn in a session with zero tools would be
treated as auxiliary.

Not covered: the session-state side call was not observed live; other
platforms; the early interactive divergences both builds show (a tool-less
streamed request at startup, each subagent's first request repeated), which are
pre-existing and need their own issue.
