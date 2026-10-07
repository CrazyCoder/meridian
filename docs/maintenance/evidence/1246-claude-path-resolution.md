# Prefer the operator-managed Claude executable (#1246)

Issue #1246 requests explicit override → usable PATH → packaged native CLI →
legacy SDK fallback. The earlier resolver silently selected a cached 2.1.268
platform package ahead of the user's mise-managed 2.1.288, so Opus 5.5 was
rejected before producing an answer. This is an internal executable-selection
fix; configuration, lifecycle, health response fields and message formats retain
their existing interfaces.

## Implementation and adversarial corrections

The async resolver now checks PATH after an existing explicit override, then
retains the bundled stub guard, platform and legacy fallbacks. CLI auth uses
the same precedence through a synchronous lookup. Startup, auth refresh, health
and SDK queries continue to share the cached async path in the server.

Two original priority assertions fail on unchanged code (35 pass / 2 fail).
Corrected resolver coverage passes 42/42, including override precedence,
lookup failure, unusable PATH fallback, Windows candidate filtering and matching
sync/async choices. A real mise install initially exposed a shim whose native
package postinstall had not run: existence alone was insufficient. PATH entries
now must successfully return a Claude Code version through a shell-free version
probe with a two-second timeout and bounded output. This checks identity and
launchability, not which installation is newest, and never upgrades the operator's
CLI. Explicit overrides retain their existing unconditional precedence.

The new synchronous lookup/version check would have reached cold `/readyz`
through its old fallback. That route now shares asynchronous resolution;
11 isolated health/readiness tests pass, including a held resolution while
`/livez` responds and a genuine missing-resolution 503. The server no longer
calls the synchronous resolver. Public readiness output and status semantics
are unchanged.

## Actual reported-client proof

The maintained Linux harness is
[`scripts/e2e-claude-path-opencode.mjs`](../../../scripts/e2e-claude-path-opencode.mjs).
It drives OpenCode **1.18.34**, the unmodified published
**opencode-with-claude 1.10.1**, SDK **0.2.141**, and the actual native requested
model. The plugin's Meridian dependency is replaced only inside the owned
verification consumer to compare published **1.68.0**, unchanged current main
`67a19e50c743942ab0ed62d340d1caf143c6140b`, and the corrected local tarball.
The stale cached Claude package is deliberately pinned to **2.1.268**; the
operator installation is **2.1.288**, managed by real **mise 2026.10.0**.
Linux x86_64 is an owned amd64 container on an arm64 host; Bun 1.4.2 runs the
parent observer, and the frontend retains its embedded runtime.

The wrapper observes the public SDK without replacing its results and captures
only startup executable metadata. Config, session namespace, project, HOME/XDG
paths and port are disposable. Credentials come from an explicit owned native
directory. Every success requires the exact random output receipt in actual
frontend JSON, the native served model, matching SDK/health executable and
credential directory, completed SDK iterators, expected frontend exit and zero
kernel-observed processes remaining in the unique fixture project. It does not
inspect private SDK persistence or replay arbitrary authorization callbacks.

| Case | Required result |
| --- | --- |
| Published 1.68.0 with healthy mise PATH and cached 2.1.268 | Chooses platform package; exact native minimum-version refusal; frontend exit 1 |
| Unchanged current main with the same cached binary | Same refusal and selected source |
| Corrected package, Opus 5.5, healthy mise PATH | Chooses PATH 2.1.288; actual Opus 5.5 receipt; frontend exit 0 |
| Explicit old override with healthy mise PATH | Override still wins; old-CLI version refusal remains visible |
| PATH has no Claude | Packaged fallback serves an actual Haiku 4.5 receipt |
| PATH contains a broken Claude launcher | Version probe rejects it; same actual Haiku fallback receipt |

Fallback controls use a model supported by the deliberately old packaged CLI;
they do not claim that 2.1.268 can serve Opus 5.5. The initial arbitrary-echo
Haiku probes reached the correct native model but refused that non-coding task.
Their receipt assertions remained failing. The final common prompt asks for the
exact output of a JavaScript fixture; baseline and fixed runs use that same
prompt. Receipts, model identity and cleanup assertions are retained. Earlier
harness exit-observation/attached-server failures are not advertised as product
reproductions or successful lifecycle proof.

Results are preserved in [the sanitized record](1246-claude-path-results.json).
No grants, account emails, auth codes, pairing URLs, raw transcripts or private
SDK files are included. Windows lookup behavior is covered by mocks and CI;
no actual Windows model call is claimed.

## Reproduce and delivery gates

Build and pack the baseline/corrected checkout without publishing, install the
chosen tarball as the owned consumer's `@rynfar/meridian`, and preserve its stale
native CLI package when comparing selection:

```sh
npm run build
npm pack --ignore-scripts --pack-destination /owned/artifacts
E2E_OPENCODE_BIN=/owned/client/opencode \
E2E_CLIENT_PLUGIN=/owned/consumer/node_modules/opencode-with-claude/dist/index.js \
E2E_SDK_MODULE=/owned/consumer/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs \
E2E_PROFILE_CLAUDE_DIR=/owned/native-credentials \
E2E_NEW_CLAUDE=/owned/claude-2.1.288 \
E2E_OLD_CLAUDE=/owned/claude-2.1.268 \
E2E_MISE_SHIM_DIR=/owned/mise/shims \
bun scripts/e2e-claude-path-opencode.mjs
```

Pass the owned mise config/data directories through `MISE_CONFIG_DIR` and
`MISE_DATA_DIR`. Baseline uses `E2E_EXPECT_VERSION_FAILURE=1` and
`E2E_EXPECT_SOURCE=platform-package`; override adds `E2E_USE_OVERRIDE=1` and
expects `env`. Fallback uses `E2E_NO_CLAUDE_ON_PATH=1` or
`E2E_BROKEN_CLAUDE_ON_PATH=1`, `E2E_EXPECT_SOURCE=platform-package`,
`E2E_EXPECT_CLAUDE_VERSION=2.1.268` and
`E2E_MODEL=claude-haiku-4-5-20251001`.

Final local gates: 5,151 pass / 0 fail / 4 skips across all 17 `npm test`
stages (pretest typecheck included), separate typecheck/build pass. Exact-head
CI including test, fresh base/head and exact merged-tree verification remain
mandatory before landing. A pinned consumer must adopt a future Meridian
release or the corrected package; no package publication is claimed here.
