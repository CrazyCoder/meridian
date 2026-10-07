# Frozen-proxy idle deadlines (#1222)

Disposition: accept with correction; local and affected-flow validation pass.
Integration: [#1241](https://github.com/rynfar/meridian/pull/1241). Check its live
state and final-head check links for the CI/merge disposition; this record
escrows the reproducible behavior proof.
Base: `f443faee0b135c5d4bfe1e6fe771c6a262ae5f33`.
Source: `1bffa43fe95037df7ac3c32fb818d01a6c3877d5` by Nowaker
(`spam@nowaker.net`), authored 2026-09-30T11:39:59Z, cherry-picked as
`66d6d2cc`; Author and AuthorDate are preserved. Maintainer corrections and
proof are separate commits.

When the proxy resumes after a long event-loop freeze, its expired idle timer
can win before queued upstream bytes are processed. The corrected guard gives
I/O a bounded opportunity only when the deadline fires more than two seconds
late. On-time deadlines, silent upstreams and ping-only upstreams still fail;
the configured idle window is not extended. Production late-deadline reporting
covers both guarded query and streaming paths. Public HTTP/plugin contracts
and session/history formats are unchanged.

## Adversarial findings and correction

- The source socket test generated upstream data in the frozen process. The
  replacement runs its writer in a separate process and exercises active,
  silent, ping-only and on-time controls through real sockets.
- The source marked every queued SDK ping as resumed progress and logged that
  the stream continued, even though a ping-only stream subsequently stalled.
  The correction excludes transport pings from that verdict and uses precise
  log wording. A real ping-only regression control verifies it remains stalled.
- An injected late-deadline observer may throw without changing the result.
  Queued completion is accepted; existing iterator teardown and ping-discard
  tests remain covered. The leaf guard has no server/session imports.
- Lateness is evidence of delayed callbacks, not proof that fsync caused them.
  Comments no longer claim an absolute scheduling guarantee or outage-rate
  reduction. No private SDK persistence is inspected or modified.

## Reproducible independent-process proof

The maintained `scripts/e2e-late-idle-sockets.mjs` freezes only the guarded
consumer for 2,700 ms with a 250 ms idle limit. Its separate upstream continues
writing throughout the pause. Both macOS arm64 Bun 1.3.14 and Node 22.22.3
baseline controls reject real queued progress after three chunks; the corrected
consumer reaches twelve chunks with a resumed late verdict. Silent and ping-only
controls fail after the late deadline, the on-time silent control fails at its
ordinary deadline, and ordinary active streaming succeeds.

Run from an isolated checkout (Node needs TypeScript stripping):

```sh
bun scripts/e2e-late-idle-sockets.mjs
node --experimental-strip-types scripts/e2e-late-idle-sockets.mjs
E2E_IDLE_GUARD_MODULE=/owned/baseline/src/proxy/streamIdleGuard.ts bun scripts/e2e-late-idle-sockets.mjs --expect-baseline
```

## Actual client / SDK / model proof

The maintained `scripts/e2e-late-idle-client.mjs` uses actual OpenCode 1.18.34,
SDK 0.2.141, Claude Code 2.1.284, Opus 5.5 and independently installed scrub
0.2.3. It freezes the proxy for 17,700 ms during an actual streamed SDK answer,
with a 15,000 ms idle limit; the native CLI subprocess remains independent.
The current fixture schedules the freeze 100 ms after the first text chunk
of the sustained answer after real tool-result resume, excluding title and
pre-tool hook waits. No SDK messages
are fabricated, replaced or withheld. An isolated tool receipt, continuation,
actual upstream served-model IDs and all-query credential affinity are asserted.

```sh
npm run build
E2E_PROFILE_CLAUDE_DIR=/owned/native-credential-directory \
E2E_PLUGIN_PATH=/owned/consumer/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/index.js \
E2E_OPENCODE_BIN=/owned/opencode bun scripts/e2e-late-idle-client.mjs
# Run the identical harness with the built unchanged baseline:
E2E_PROXY_MODULE=/owned/baseline/dist/server.js \
E2E_PROFILE_CLAUDE_DIR=/owned/native-credential-directory \
E2E_PLUGIN_PATH=/owned/consumer/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/index.js \
E2E_OPENCODE_BIN=/owned/opencode bun scripts/e2e-late-idle-client.mjs --expect-baseline
```

Explained probe corrections: the first client run omitted debug telemetry, so
its client receipts/resume passed but it could not assert the late verdict.
Enabling the actual telemetry corrected that instrumentation. A primary-only
pre-tool trigger could freeze while the consumer waited in a hook, rather than
with an armed pending iterator pull; it did not establish a baseline failure.
The sustained resumed-answer trigger supersedes it. Linux fixture setup first
lacked Bun for a dependency install hook, then ran that dependency hook in a
directory without a lockfile; dependencies were installed without those build
hooks. A hyphenated UUID was not an accepted native machine ID; a generated
32-hex identity corrected the isolated container. A read-only mount of the entire Linux Claude config directory prevented native
session persistence, so resume attempts replayed instead of exercising the
intended sustained resumed stream. The isolated config directory was made
writable for supported CLI session persistence. These are fixture failures,
not production fixes or unexplained green reruns.

## Final before/after and validation

Durable [sanitized verdicts](1222-late-idle-verdicts.json) escrow the exact
measured facts without ephemeral artifact paths or client transcript text:

| Actual flow | Unchanged baseline | Corrected tree |
| --- | --- | --- |
| macOS arm64 / Bun 1.3.14 | Two false stall records at 17,712/17,713 ms; client answer exits 1 | Two resumed late verdicts at 17,709 ms; zero stalls, answer/continuation exit 0 |
| Linux arm64 / Bun 1.4.2 | Two false stall records at 17,726 ms; client answer exits 1 | Two resumed late verdicts at 17,726/17,727 ms; zero stalls, answer/continuation exit 0 |

Each measured flow used actual OpenCode 1.18.34, SDK 0.2.141, Claude Code
2.1.284, Opus 5.5 and independently installed scrub 0.2.3. Every actual query
matched the isolated credential directory; real upstream messages confirmed
Opus 5.5. Both corrected flows completed the real tool receipt and later
recall, with actual SDK resume. The two records are the nested production
query/stream guards observing the same single proxy freeze.

Independent socket before/after and all negative controls also pass on Linux
arm64 Bun 1.4.2 and Node 24.20.0. This verifies runtime I/O ordering, not an
additional actual Node model/client flow. All four actual Opus E41
chain/parallel × JSON/stream modes pass on macOS: tool/result pairing,
supported active SDK history, durable forks and cache-prefix continuity.

Final local `npm test`: 5125 pass / 0 fail / 4 skips;
standalone typecheck/build pass. Final-head CI remains the integration gate.
Raw client output and OAuth grants remain private. No production outage-rate
reduction, reproduction of the contributor's actual disk saturation, or
automatic browser callback success is claimed.
