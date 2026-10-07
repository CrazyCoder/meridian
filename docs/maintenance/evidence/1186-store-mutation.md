# Session-store mutation review and proof

Source [#1186](https://github.com/rynfar/meridian/pull/1186):
`9d33e45f4c88d24a633683f79f67b0bbf0eb1681`, Nowaker `<spam@nowaker.net>`,
AuthorDate `2026-09-28T05:10:18-05:00`. Authored cherry-pick after current-main
rebase: `25defa3583af796aa88fca63b2074134fba6d676`.
Maintainer correction `d5dc2a4331efe67dc143ea2c0eff214d975bd36c`.
Final base `98c48c03ff65f0b8ce428c8b60718655c49f85dd`.

## Concrete findings and corrections

The optimization is useful: reusing an identity-checked parsed document and
unchanged entry bytes removes repeated CPU work while retaining the locked
fsync/rename protocol. Reviewed the full diff, every store mutator, snapshot
and lookup exposure, session-cache readers, priority assignment/rollback
publication and transcript locator handling.

Two new tests fail on the authored change (6 pass / 2 fail):

- Caller arrays remain aliased. After writing, modifying the caller's message,
  block-hash or UUID arrays changes the read cache while memoized disk bytes
  remain unchanged.
- The top-level freeze allows nested lookup edits, also diverging from disk.

Correction owns a deep copy of each changed entry before memoization. Parsed
data is privately owned; nested values are frozen before lookup/snapshot
exposure, while unchanged entries retain their serialization identity. Maps
and metadata are frozen as well. A foreign-writer regression test covers the
parse/exposure path separately. Focused corrected tests: 9 pass / 0 fail.

The first full suite exposed another in-place mutation in the existing
`silent-turn-recovery.test.ts` assertion: `.sort()` edited the cached tool-ID
array. Changed the assertion to `.toSorted()` without changing its comparison.
All 13 focused silent-turn recovery tests pass. No production caller was found
mutating the newly protected arrays. Final full-suite/CI outcomes belong in
the delivery PR; the failed full run is not claimed as passing.

## Retained headless process benchmark

`bun scripts/e2e-session-store-cost.mjs` constructs a disposable 19,270,219-byte
store with 856 entries and 250 message hashes per entry. It asserts unchanged
entry count and nested history, then records 30 warm writes' event-loop delay.
It deliberately does not impose a noisy performance threshold.

Run the same committed script on baseline `c04a861ba` (copy it to that isolated
checkout) and the delivery tree, using Bun 1.3.11 on the same filesystem.
macOS arm64 observations under concurrent verification load:

| Case | Median write loop delay | P95 | Cold lookup |
| --- | --- | --- | --- |
| Baseline run 1 | 70.83 ms | 125.05 ms | 46.17 ms |
| Baseline sequential run | 95.73 ms | 137.85 ms | 50.33 ms |
| Initial eager-freeze correction | 10.60 ms | 35.05 ms | 262.62 ms |
| Final lazy exposure, freeze instrumentation | 20.76 ms | 35.21 ms | 35.07 ms |

The initial eager-freeze version walked every nested array on a cold lookup.
It was replaced with freezing only exposed nested data. `--trace-freeze`
records 1,114 actual freezes taking 1.29 ms during the final cold lookup, rather
than walking the whole store. Other cold samples under test load ranged above
200 ms, so cold-read timing remains noisy; this is evidence of bounded freeze
work and improved warm CPU work, not a guarantee on latency under arbitrary
disk/GC pressure. Writing/fsyncing the whole file still scales with its size.
The original overloaded Linux host's 40–120 second stalls were not reproduced.

## Actual client and model evidence

Built Meridian, actual OpenCode 1.18.33, Opus 5.5, Agent SDK 0.2.141,
Claude Code 2.1.284, independently registry-installed OpenCode scrub 0.2.3.

```sh
bun scripts/e2e-session-store-cost.mjs
E2E_SESSION_STORE_FIXTURE=<printed-artifact>/sessions.json \
E2E_TOOL_RECEIPT=1 E2E_CONCURRENCY=2 E2E_MODEL=claude-opus-5-5 \
E2E_PLUGIN_PATH=<isolated-install>/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/index.js \
bun scripts/e2e-opencode-lifecycle-admission.mjs
```

PASS: two concurrent real clients on a 19.3 MB seeded store. Each first turn
executed one tool and emitted text, with exit 0 and no errors. Random receipt
present only in each client's fixture file appeared in a real `tool_result`
request reaching the SDK. Each next turn exited 0, emitted text with no errors,
and retained its own client session. Scrub ran eight times with zero errors.

Retained failure: the first tool-receipt fixture used a wildcard deny plus read
allow, and OpenCode sent no tools, only attempted textual tool syntax. Both
clients answered but zero tool events/receipts made the gate correctly fail.
The corrected disposable fixture enables tools and uses an absolute fixture
path. This was a harness correction, not an unexplained product rerun.

All four real Opus E41 modes also passed before the final exposure optimization:
chain/parallel × stream/nonstream, exact pairing, durable forks, supported SDK
history and full cache continuity. Final rebased-source E41 and actual-client
runs are rechecked and recorded in the delivery PR before acceptance.
Temporary private client transcripts remain outside source; only these sanitized
assertion outcomes are preserved. This is macOS evidence, not a Windows/Linux
or multi-process-filesystem performance claim.

## Full-suite process isolation correction

The combined-process run measured 80.1 ms warm timer lag against a 33.2 ms
baseline and failed its unchanged 75% bound. The same file alone measured
9.8 ms against 37.7 ms (9 tests pass). A zero-delay timer also measures work
from other asynchronous tests sharing the process, and this file changes the
process-global store directory. Run it in a separate npm-test stage, matching
the existing session-store isolation policy; preserve the assertion and all
nine tests. Final full-suite results are recorded in the delivery PR.
