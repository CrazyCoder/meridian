# Antigravity client catalogs above 128 tools (#1238)

Accept: remove the unsupported catalog-count validation, retain per-tool name,
duplicate, schema and forced-choice checks, and preserve the runtime's separate
32-pending / 256-conversation-action limits. A catalog advertises available
choices; its size is not a count of executed actions. No configuration, plugin
interface, model mapping or tool execution permissions are added.

## Before and after

Two direct count regressions (129 and 256 definitions) fail on unchanged code,
then pass after removing only `.max(128)`. The backend suite passed 71/71 during
iteration; the final change adds a real HTTP malformed-schema control at the
catalog tail, and all final local gates pass: **5,154 pass / 0 fail / 4 skips**
across 17 `npm test` stages, pretest plus separate typecheck, and build.

The maintained `scripts/e2e-antigravity-tool-catalog.mjs` drives **OpenCode
1.18.30**, official **agy 1.2.7**, actual **gemini-3.8-flash-high**, Node
22.22.3, macOS arm64. The reported platform was unspecified; no Linux or Windows
claim is made. The owner global agy is now 1.2.16, which Meridian correctly
refuses before generation. The test downloads the official 1.2.7 release into
an owned directory and never downgrades, upgrades or bypasses the global CLI
compatibility gate. Existing official account authentication remains with agy;
no Gemini API keys or copied private CLI transcripts are used.

Two real stdio MCP servers advertise the fixture catalog to the actual client.
Only its final tool can read a random receipt from the owned project. The prompt
never contains that value. The relay observes unmodified actual client HTTP and
forwards real Meridian/CLI responses. Acceptance requires the entire MCP catalog,
a target beyond index 127, exactly one real target invocation, its result in the
next actual client request, the exact frontend receipt, exit zero, both recorded
client MCP PIDs gone, no backend preparing/live processes and joined shutdown.

| Case | Actual client result |
| --- | --- |
| Published Meridian 1.76.5, 129 MCP definitions | 139 total tools; exact HTTP 400 `<=128` refusal; exit 1; no client tool executed |
| Current main `4170a8a7f30c98de99d411321158b41a71098b6f`, same catalog | Same refusal, target at index 129, no tool executed |
| Independently unpacked corrected tarball, 129 MCP definitions | All 139 definitions retained; tail tool once; exact receipt and returned client result; exit 0 |
| Corrected source, 256 MCP definitions | All 266 definitions retained; target index 256; same receipt/result/exit assertions pass |

Both positive actual-client runs also send invalid-name, duplicate-name and
malformed-JSON-schema requests beyond the former cap. Each still returns HTTP
400 for its specific reason; no live/preparing process remains. The 129/256
runs are single conversations, without automatic model reruns to obtain passes.
The catalog is synthetic, but discovery, registration, tool dispatch and result
execution belong to the actual OpenCode client and real account-backed CLI.
This does not attest to every third-party MCP server.

The first observer prototype incorrectly assumed the first client request was
tool-bearing; OpenCode had sent a separate title request. Its assertion failed.
The final harness sets a title explicitly and selects the actual catalog-bearing
request. No failed prototype is counted as before/after or cleanup proof.

[Sanitized results](1238-antigravity-tool-catalog-results.json) retain versions,
counts, exit/result/cleanup facts and negative controls. No grants, cookies,
account identities, authorization codes, private CLI files or raw transcripts
are committed. The original unchanged baseline was `67a19e50`; its Antigravity
code is unchanged by #1250. Final current-main controls were repeated against
#1250's exact merged tree before acceptance. Product commit `c285d89d` was
rebased onto current main before final local/source/package verification.

## Reproduce

```sh
npm run build
E2E_OPENCODE_BIN=/owned/opencode-1.18.30 \
MERIDIAN_AGY_PATH=/owned/official-agy-1.2.7 \
node scripts/e2e-antigravity-tool-catalog.mjs
E2E_CATALOG_SIZE=256 E2E_OPENCODE_BIN=/owned/opencode-1.18.30 \
MERIDIAN_AGY_PATH=/owned/official-agy-1.2.7 \
node scripts/e2e-antigravity-tool-catalog.mjs
```

For the before control set `E2E_EXPECT_TOOL_LIMIT=1` and
`E2E_SERVER_MODULE=/owned/baseline/dist/server.js`. For package verification,
pack without publishing, unpack in an owned dependency environment and set that
module path to the installed package. Credential-backed calls consume quota.
Exact final-head CI, fresh merge state/base and merged-tree validation remain
mandatory. A merged source fix does not publish a new package.
