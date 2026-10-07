# Auth-status refresh proof

Source: [#1197](https://github.com/rynfar/meridian/pull/1197),
`3baf6f598a851f11e2bf761ce091f96d82bd63c2` by Nowaker
`<spam@nowaker.net>`, AuthorDate `2026-09-28T21:21:37-05:00`.
Cherry-pick `e97c6f6140e9772617b99d5c11f9d2323a6c1783` preserves both.
Baseline `c04a861ba8a4fb71d105065afa9b73019d9985f4`.
Maintainer harness/documentation is separate from the authored contribution.

## Before and after

The committed [harness](../../../scripts/e2e-auth-status-refresh.mjs) uses
real auth, actual HTTP sockets, isolated state, read-only credentials and a
wrapper that delays only `claude auth status` before forwarding to the real CLI.
It never substitutes a fake auth result. Same two-second fault and assertions:

| Case | Five concurrent health latencies (ms) | New auth subprocesses | Exit |
| --- | --- | --- | --- |
| Unchanged baseline, `--expect-blocking` | 2258, 2258, 2258, 2258, 2258 | 1 | 0 |
| Authored fix | 2, 4, 4, 4, 4 | 1 | 0 |

Fixed probes return while the refresh remains in flight. `/v1/models` returns
200 within one second during it. After completion, another healthy probe causes
no extra spawn. All probes establish actual `auth.loggedIn: true`.
Commands: `bun scripts/e2e-auth-status-refresh.mjs` on the delivery tree and
the same committed script copied to unchanged baseline with `--expect-blocking`.
macOS arm64, Bun 1.3.11, Node 22.22.3, Claude Code 2.1.284.

## Actual headless client

Independently installed registry package `@rynfar/meridian-plugin-opencode-scrub`
0.2.3; built Meridian; OpenCode 1.18.33; SDK 0.2.141; Opus 5.5.

```sh
E2E_PLUGIN_PATH=<isolated-install>/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/index.js \
E2E_MODEL=claude-opus-5-5 bun scripts/e2e-opencode-lifecycle-admission.mjs
```

PASS, exit 0. Both actual client turns exited 0, emitted one text event and no
error events, retained the same client session. Scrub had three invocations and
zero errors, removed the observed identity/environment fingerprint and retained
the working directory. Private transcripts/configuration remain outside source;
only sanitized assertion outcomes are preserved here.

## Adversarial review and limits

Read the complete diff and all five auth-status consumers: request model
selection, health, profiles, model discovery and startup warm-up. No response
shape or plugin configuration/lifecycle contract changes. Logic stays in the
leaf models module. Concurrent warm and cold callers share the refresh;
completion clears only its own slot. Explicit logged-out successful payloads
replace old successful payloads. Failure delays cap at five minutes and reset
on success; credential-mtime changes still initiate a refresh.

Known tradeoff: an expired cached payload (including one invalidated by a
credential change) is returned once while refreshing. This may briefly retain
the previous login/plan reading. Failed checks retain last-known-good as before;
backoff can delay detecting recovery up to five minutes. First checks with no
previous payload still wait. Tests cover these cold/failure/backoff/isolation
paths; headless live proof covers warm refresh and adjacent real model traffic.
The original high-load Linux host and Windows were not independently exercised.

Required local gates and exact-head CI are recorded in the delivery PR before
acceptance. No release or community message is part of this change.
