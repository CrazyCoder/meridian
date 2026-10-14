# #1231 Agent-tool subagent session keys: live before/after (2026-10-13)

Contributor PR #1231 by @passabilities, stacked on #1211, merged as `84e161b9c`
(Author on `main`: passabilities). The only maintainer commit on the branch was
a merge of `main` after #1211 landed. Its conflicts were adjacent-line overlaps
with #1211's squashed copy of the same commits; they were resolved to the PR's
side, plus one duplicated adapter method removed. The resulting diff against
`main` was checked to equal the PR's own five commits.

Gate: E72, `bun scripts/e2e-claude-code-subagent-session.mjs`, shipped by the
PR. Real Claude Code 2.1.296, model `sonnet`, macOS arm64; two turns that each
spawn two parallel Agent-tool subagents.

| | `main` with #1211 `eb1f46211` ([baseline.txt](baseline.txt)) | PR merged with `main` `fb2b4fa76` ([candidate.txt](candidate.txt)) |
|---|---|---|
| Subagent turns that resumed their own session | 0 of 4 (`unrelated-history`) | 4 of 4 |
| Main requests that resumed | 1 of 2 | 2 of 2 |
| Longest session-lease wait | 3,465 ms | 4 ms |
| Result | FAIL, 4 checks | PASS |

Local gates on `fb2b4fa76`: `npm test` and `npm run build`, zero failures.
Final-head CI green on all checks.

## Review

An independent review found no regression. Requests without
`x-claude-code-agent-id` are keyed exactly as before; an agent id never creates
a key on its own and is limited to `[A-Za-z0-9_-]{1,128}`. Low items: one stored
mapping per subagent (within the existing caps), the `[1m]` rate-limit bench is
now per subagent, a backgrounded main session costs one full replay on its new
key, and Claude Code behind a gateway (passthrough adapter) gets neither #1211
nor #1231.

Not covered: CLI versions other than 2.1.296, platforms other than macOS arm64,
agent-id stability across a subagent's turns beyond this run.
