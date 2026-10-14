# #1211 auto-mode classifier isolation: live before/after (2026-10-13)

Contributor PR #1211 by @passabilities, merged as `eb1f46211` (Author on `main`:
passabilities). The only maintainer commit on the branch was a conflict-free
merge of `main`.

Gate: E71, `bun scripts/e2e-claude-code-auto-mode.mjs`, shipped by the PR. Real
Claude Code 2.1.296 in `--permission-mode auto`, model `sonnet`, macOS arm64,
four turns of one conversation; turn 4 sets `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`.

| | Unchanged `main` `afd116e87` ([baseline.txt](baseline.txt)) | PR merged with `main` `d443564b2` ([candidate.txt](candidate.txt)) |
|---|---|---|
| Classifier requests seen | 3 of 10 requests | 3 of 10 requests |
| Classifier handled as | `lineage=new diverged=unrelated-history` | `independent-request:auxiliary-request` |
| Main requests that resumed | 3 of 6 (each one after a classifier call replayed from scratch) | 6 of 6 |
| Result | FAIL, 4 checks | PASS |

Local gates on `d443564b2`: `npm test` (typecheck, then the full suite) and
`npm run build`, zero failures. Final-head CI green on all checks.

## Review

An independent review found no regression. One gap, not a regression: the
classifier's second stage (`xml_s2`, sent when stage 1 says block) carries no
`stop_sequences`, so it is not detected and still replaces the mapping, as it
did before. The fix is to also accept the classifier's system prompt when stop
sequences are absent (`src/proxy/adapters/claudecode.ts`). Also noted: the
`x-claude-code-request-class: auxiliary` header is trusted outright (it can only
affect the caller's own conversation), and ARCHITECTURE says an auxiliary
request skips session lookup, while the durable-store lookup still runs.

Not covered: CLI versions other than 2.1.296, the `fast` and `thinking`
classifier modes, platforms other than macOS arm64.
