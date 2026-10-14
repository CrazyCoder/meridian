# #1232 upstream reachability: contract corrections and live check (2026-10-14)

Contributor PR #1232 by @Nowaker adds passive Claude reachability to `/health`
and `/readyz`. The owner approved the contract in #1281. Merged as `0559c554d`
(Author on `main`: Damian Nowak) with a maintainer `Co-authored-by`, because the
maintainer commit `4539ece6b` on the branch changed the fix.

## Maintainer commit on the contributor's branch

Review of the contributor's head `0faf4fc97` (by Gemini 4 Argon via
Antigravity, with its key findings re-checked in the code) found these gaps, all
closed in `4539ece6b` with tests:

1. A process-wide tracker shared by every embedded proxy instance; the module
   also read settings itself. Each instance now owns its tracker, and the
   configuration reader is separate.
2. Slow responses (`api_retry` with no status, `ETIMEDOUT`, generic timeouts)
   counted as connection failures, and one failed request counted twice.
3. Loose text, replayed or synthetic messages and a stream's final message
   could count as an answer and clear an outage.
4. `PUT /upstream-reachability` accepted cross-origin browser writes (reproduced
   with an `Origin` header), set `no-store` only on success, and took
   `ttlMs: null` as the default.
5. `/health` took its reachability snapshot before awaiting auth status.
6. Huge configured durations made `/health` and `/readyz` throw; malformed
   settings were not ignored.
7. `since` was wrong while an override was forced and after it ended.
8. The status pill outranked draining and offline states and named Anthropic
   rather than this instance's Claude connection; it was not accessible by
   keyboard.
9. Docs did not state the setting precedence.

The corrections were ported from an earlier maintainer implementation of #1281;
its harness and evidence were not. The route test now runs in its own process,
since it mocks `models.ts` for the whole process.

## Live check

E75, `bun scripts/e2e-upstream-reachability-live.mjs`, Opus 5.5, macOS arm64,
on `4539ece6b` ([report](candidate-report.json)): a real answer recorded; with
the SDK subprocess pointed at a dead proxy port, two refused connections failed
`upstream-claude` while `/livez` stayed up; after the hold the state moved to
`probing` and one real answer cleared it. 7 of 7 checks. Unchanged `main` has
no `upstream.claude` field or readiness check, so there is no baseline run.

Local gates: `npm test` and `npm run build` with zero failures. Final-head CI
green.

Not covered: a real network outage (the cut is a refused proxy connection),
Linux, the combined Antigravity backend at runtime, the header UI in a browser.
