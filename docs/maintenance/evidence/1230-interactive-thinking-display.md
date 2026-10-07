# Interactive thinking display compatibility (#1230)

Reviewed source `d50e28062bad5b98f93359e268ce53aa8facd868` against unchanged
main `928bddc42b684680bc58f31a0aab18034197e8f3`. Accept with a separate
maintainer correction: unsupported API display values must not terminate the
bundled SDK subprocess, and the actual current request must remain live input.
No exported plugin lifecycle or route contract is changed.

## Attribution and implementation

Noah Passalacqua's source commits retain Author and AuthorDate:

| Source | Authored cherry |
| --- | --- |
| `4f2c92cb1a32d42d6305ed231d05cbde4a2ac3af` | `6878bd87` |
| `ed29641922a9d6d6cb3349b7ba0d438d401b11ce` | `e8aed924` |
| `3936f131f9bd8aa0be477c4232f9f101301b376a` | `7838d66e` |
| `d50e28062bad5b98f93359e268ce53aa8facd868` | `29047016` |

The central query builder retains `summarized`, `omitted`, and `highlights`,
removes unknown display values while preserving thinking mode/budget, and logs
the dropped value. All query/retry construction shares that boundary. A narrow
SDK type assertion preserves CLI-supported `highlights`; no SDK result is mocked
in the live gate. Disabled thinking remains disabled.

## Material finding and causal correction

Source-only integration survived the subprocess argument check, but the actual
Claude Code 2.1.287 TUI appended a `system` reminder after its user request.
Meridian coerced that reminder into a user turn; replay framing consequently
put the current request inside `<conversation_history>`. The model refused to
answer the quoted historical request. This reproduced on macOS arm64 and Linux
x86_64. The strict receipt assertion stayed in place.

Two HTTP-to-mocked-SDK regressions fail on source-only code (38 pass / 2 fail).
The maintainer correction coalesces only terminal system messages immediately
after a user turn in the replay copy, preserving content order and media/tool
blocks. It preserves original client messages for lineage and budget accounting.
Text framing retains the original roles; structured replay identifies a terminal
user explicitly. Middle reminders, assistant-ending history and system-only
input are negative controls. Focused checks now pass 56 tests, including real
HTTP fresh, structured-media and resumed-turn prompt assertions and pure replay
controls. The baseline supported-`summarized` control also records the current
request inside history and completes without a receipt, independently of the
unsupported argument failure.

## Real before/after proof (2026-10-03)

The committed harness is
[`scripts/e2e-thinking-display-interactive.mjs`](../../../scripts/e2e-thinking-display-interactive.mjs)
with its [PTY driver](../../../scripts/e2e-thinking-display-interactive-driver.py).
It runs actual frontend Claude Code **2.1.287**, actual SDK **0.2.141**, bundled
CLI **2.1.284**, native **claude-sonnet-5**, Bun **1.4.2**. macOS uses arm64;
Linux x86_64 uses an isolated amd64 container on this arm64 host. Python 3,
`pyte==0.8.2`, `wcwidth==0.2.13` reconstruct streamed terminal updates. The relay
leaves the actual messages, thinking settings and upstream response unchanged;
its token-count endpoint is a fixture and not a production token-accuracy test.

| Case | Unchanged main | Corrected integration |
| --- | --- | --- |
| macOS interactive `updates` | Native invalid-argument rejection, no receipt | Receipt in completed SSE and rendered TUI; unknown display removed |
| Linux x86_64 interactive `updates` | Same native rejection, no receipt | Same receipt and cleanup assertions pass |
| Interactive `summarized` | Separate macOS framing control loses receipt | macOS + Linux pass; display retained |
| Interactive `highlights` | Not an asserted baseline control | macOS pass; display retained |
| Interactive disabled thinking | Not an asserted baseline control | macOS + Linux pass; disabled retained |
| Actual print-mode `omitted` | Not an asserted baseline control | macOS + Linux pass; omitted retained |

Every successful run verifies the actual native served model, owned credential
directory, a current request outside the history envelope, exact frontend
version, HTTP and frontend receipt, absence of error events, and joined cleanup.
The unchanged-main `updates` controls use the same final harness configuration
as their after runs. Sanitized wire/query facts are preserved in
[1230-thinking-display-results.json](1230-thinking-display-results.json),
without pairing URLs, auth codes, grants, raw transcripts or private SDK files.

The interactive `omitted` attempt emitted `updates` and is not counted as an
omitted-display success; actual print mode supplies that separate control.
Earlier harness startup/terminal-parser failures are not product reproductions.
No cache threshold or receipt assertion was relaxed to obtain a green result.

All four maintained E41 sequential/parallel JSON/SSE modes pass on native
Sonnet 5: correct batching, exact active tool history and each continuation's
prior cached prefix. The 95% canonical-prefix gate is unchanged. These are
adjacent replay regressions; the PTY runs establish the reported actual client.

## Reproduce and final gates

Follow [E73](../../../E2E.md#e73-unknown-thinking-display-values) for pinned
client, native credentials, Python dependencies, baseline and supported/off
commands. Native grants are deliberately outside the repository. Model access
and credentials are required; these live calls do not run in ordinary CI.

Final local `npm test` (including pretest typecheck), separate typecheck/build,
exact-head CI including `test`, source-head freshness and exact merged-tree/
human-credit verification remain mandatory integration gates. Final CI links
and delivery SHA are recorded in the PR and review handoff.
