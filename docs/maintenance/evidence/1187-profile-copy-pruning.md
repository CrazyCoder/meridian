# Profile-copy pruning (#1187)

Reviewed source `8fa90cbcef8b039b5b95ac0df022e405f229f624`, base
`3cb65df0c`. Nowaker's actual authored commit is cherry-picked as `ec5a107d`;
Author/AuthorDate remain intact. Maintainer corrections are separate:
`f4e0fa3b` reserves retirement capacity under the lifecycle lock,
`c0f0564c` fences arriving local/foreign turns without waiting under that lock,
`9a36b052` makes native-history deletion explicit opt-in.

## Product decision and adversarial findings

Accept with corrections. Large stores can retain obsolete copies of the same
conversation under several account profiles. An enabled sweep keeps the newest
copy, copies inside the grace period, active conversations, unrelated single-
profile sessions and priority-assignment/rollback authority. It releases stale
mappings into the existing SDK-backed retirement queue. Returning after deletion
replays the available client history; native SDK thinking history is lost.
`MERIDIAN_SESSION_PROFILE_COPY_PRUNE` therefore defaults to disabled. Operators
must opt in; `MERIDIAN_SESSION_PROFILE_COPY_GRACE_MS` defaults to 24 hours.

The authored budget calculation could race another sweeper or new admission:
both could release more transcripts than the bounded retirement queue could
accept. Reconciliation and capacity reservation now share the lifecycle lock,
leaving half the capacity for admissions. A second finding was a foreign turn
arriving after an idle observation. Nonwaiting cross-process maintenance leases
fence each selected conversation; busy conversations defer to a later sweep.
Direct regression tests exercise both interleavings, previous-transcript costs,
foreign lease arrival, active/local turns, newest-copy ties, grace, defaults,
priority metadata and unrelated mappings. No durable deletion occurs outside
the existing supported SDK lifecycle.

## Verification (2026-10-02)

Final local code gates: npm test 5,116 pass / zero failures / four skips;
standalone typecheck and build pass. Focused pruning: 12 pass / 55 assertions;
HTTP/admission/default policy: eight pass / 41 assertions.

Maintained actual-client harness: `scripts/e2e-profile-copy-prune-client.mjs`.
macOS arm64, Bun 1.3.11, OpenCode 1.18.34, Agent SDK 0.2.141, Claude Code
2.1.284, independently installed OpenCode scrub 0.2.3. Upstream assistant
messages confirm `claude-opus-5-5`. Real SDK query handles/methods remain intact.
Two profile aliases share one access-only OAuth grant: this proves lifecycle,
not distinct-account failover. The harness ages only Meridian's isolated
mappings, never edits or reads private SDK transcript files, and checks history
through the supported `getSessionMessages` API.

Enabled and disabled runs each used nine real SDK queries and exited zero:

| Assertion | Enabled | Disabled control |
| --- | --- | --- |
| Tool reads random receipt; continuation recalls it | pass | pass |
| Return within grace uses native resume | pass | pass |
| Native fork source remains immutable | pass | pass |
| Aged superseded mapping removed | yes | retained |
| Supported SDK confirms retired transcript deletion | yes | no deletion requested |
| Newest profile's ID/history unchanged by sweep | pass | pass |
| Unrelated aged single-profile conversation retained | pass | pass |
| Return after sweep preserves receipt | replay | native resume |

E41's four modes also pass with actual Opus 5.5 and the same SDK/CLI: sequential
and parallel tools, streaming and JSON. Each delivered tool call has exactly
one real answer in the active SDK history; every continuation reads the cached
prefix; follow-up history remains resumable. Sequential cache-read shares were
96–98%; parallel continuation/follow-up shares were 86%/98%.

Initial probe failures are retained as evidence limits: a harness using
`createProxyServer` without startup initialization fell back to the SDK's older
CLI; the corrected harness uses actual `startProxyServer` and records the
executable version. An initial default-host OAuth grant was rejected with 401
(revoked despite a future expiry). The passing runs use the independently
created isolated browser-login account, whose actual live requests succeed.
These are explained setup/credential corrections, not unexplained green reruns.
No credential, OAuth URL/code or raw client transcript is published.

## Reproduction

Build first (`npm run build`). Supply an owned mode-0600 JSON file containing
only `accessToken` and future `expiresAt`; do not include a refresh token. Point
`E2E_PLUGIN_PATH` at an independently installed scrub's `dist/index.js`.

```sh
E2E_AUTH_FILE=/owned/private/access.json \
E2E_PLUGIN_PATH=/owned/scrub/dist/index.js \
E2E_PRUNE_ENABLED=1 \
npm exec --yes --package=bun@1.3.11 -- bun scripts/e2e-profile-copy-prune-client.mjs
```

Repeat with `E2E_PRUNE_ENABLED=0` for the native-resume control. The harness uses
isolated configuration/session/client directories and a random loopback port.
`E2E_CLAUDE_BIN` can select an explicit supported Claude Code executable.
Run `scripts/e2e-passthrough-turns.mjs` per E41 for each of its four modes, with
read-only credentials and pruning enabled. Private logs are supporting local
artifacts; this record and the committed harness are the durable proof.
Required exact-head CI remains a merge gate. No release is authorized.
