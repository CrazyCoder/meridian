# #1297 auxiliary replay cache reuse: live before/after (2026-10-14)

Contributor PR #1297 by @justprosh, merged as `74ee96752` (Author on `main`:
Aleksey Proshutinskiy). The only maintainer commit on the branch was a merge of
`main` after #1292 landed, recorded as the PR's own diff applied to `main` and
checked line-for-line.

Gate: E76, `bun scripts/e2e-auxiliary-cache-live.mjs`, Sonnet 5.5, macOS arm64.
Three caption-shaped requests over one subagent history that grows by one tool
round each time.

| Caption | `main` `cbed8faaa` write / read ([log](baseline-main-cbed8faaa.txt)) | PR `dcd3498c0` write / read ([log](candidate-pr-dcd3498c0.txt)) |
|---|---|---|
| 1 (4 rounds) | 11,572 / 0 | 10,810 / 757 |
| 2 (5 rounds) | 11,383 / 2,292 | 4,788 / 8,882 |
| 3 (6 rounds) | 13,464 / 2,292 | 4,788 / 10,961 |

On `main` every caption rewrites its whole history to the cache; with the PR
each later caption reads the shared history and writes only the new round and
the tail. All six requests were handled as auxiliary.

Local gates on the merged head: `npm test` and `npm run build`, zero failures.
Final-head CI green; merged with `--admin` (unsigned commits only), explicit
`--body`, no maintainer trailer.

## Review

An independent review (Gemini 4 Argon via Antigravity) confirmed the replay is
byte-identical to the old single string over ten input shapes, that only
auxiliary fresh replays reach the new path, that the request stays within four
cache breakpoints with the CLI's own, and that the six `DISABLE_PROMPT_CACHING*`
switches match the CLI's. Low items: the byte-identity test covers three shapes;
`FORCE_PROMPT_CACHING_5M` is set for every auxiliary request even when no
breakpoint is added; managed-policy settings are not visible to Meridian.

Not covered: real classifier sequences (the requests here are caption-shaped
HTTP requests through the real proxy, SDK and model, not the interactive
client), other platforms.
