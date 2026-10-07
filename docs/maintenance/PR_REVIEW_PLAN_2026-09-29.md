# PR review and delivery plan — 2026-09-29

## Scope and evidence level

Refreshed GitHub against Meridian `origin/main`
`0ec52a28d9c70d0f9aa84767613c7a08125d25e4`. The queue contains 12 Meridian
PRs and two OpenCode scrub PRs. Paginated accessible-repository discovery found
five owner-controlled scrub repositories: hudscrub, hermes, openclaw, opencode
and pi. The other four have no open PRs. This is a PR batch, not an issue sweep.

This record is a triage and implementation plan. Only #1191 has independent
full local and browser validation in this batch. The larger proposals need the
complete final-diff/caller review and gates below before acceptance; contributor
validation claims are not our proof. No merge, release or community comment is
part of this checkpoint. Preserve the owner's dirty desktop checkout.

## Delivery order and dispositions

1. **#1191 — accept as proposed, integration prepared.** The table wrapper
   follows the shared color tokens and confines overflow without changing inputs,
   event handlers or pricing data. Contributor's regex test only checks markup;
   our real bundled-server browser check establishes layout and focus behavior.
   See [independent evidence](evidence/1191-settings-overflow.md).
2. **#1186 — accept direction; acceptance pending correctness and performance
   proof.** Avoiding repeated parse/encoding is useful and retains file locking,
   fsync and rename. Audit every mutator and caller before accepting the new
   immutable-entry contract: `Object.freeze(session)` is shallow, while the
   serializer memoizes bytes by object identity. Nested arrays/locators must not
   mutate after serialization. Test failure rollback, nested aliasing, foreign
   writers, inode replacement and priority generations. Keep noisy timing
   benchmarks separate from deterministic correctness gates. Reproduce large-store
   event-loop stalls with a committed process harness; compare baseline/final
   request latency and run real OpenCode resume/tool rounds under concurrent load.
   CPU improvement alone does not prove the reported 40–120 second stalls fixed.
3. **#1187 — defer until #1186 and deletion-safety proof.** Its diff includes
   #1186 plus a second authored commit: incorporate the dependency once, then
   cherry-pick only the new commit. This changes retained history, not merely
   performance: after pruning, returning to a profile replays flattened history.
   Test the cross-process race between `isHeld()` and mapping deletion, priority
   rollback protection, unknown/colon-bearing keys, backlog saturation and grace
   boundaries. Commit a headless multi-profile harness proving resume before the
   boundary, replay afterward, no live transcript deletion, and successful fresh
   admissions. Run E41 in all four modes plus real profile-switch/tool-result
   flows. The contributor explicitly has no live resume/replay E2E for this PR.
4. **#1190 — accept direction with correction; contract decision first.**
   Useful supervisor observability, but `total: 0` is not a safe-restart guarantee:
   Antigravity background Responses jobs are excluded, standalone Antigravity
   lacks the endpoint, and new requests can arrive after a probe. Its own docs
   acknowledge these limits but still say zero interrupts nobody. Count active
   background jobs or narrowly name/document the metric and avoid that guarantee.
   Review response completion versus socket delivery, queued cancellation,
   failover counting, and GET event streams. Prove actual Claude and combined
   Antigravity traffic, queue/drain, disconnects and background-job controls through
   real sockets. Add a retained harness. Resolve API approval/issue requirements
   before modifying the stable contract.
5. **#1189 — accept direction with a blocking redaction correction.**
   Independently reproduced: `describe()` assigns `value.name` directly to
   exception `type`; `new Error("safe message")` with name
   `Bearer synthetic-review-secret` survives `exceptionChain()` unchanged.
   Thus the claim that every exported string is scrubbed is false. Scrub/bound
   exception names and test the complete serialized spool/envelope, not only
   messages. Also assess absolute path disclosure, arbitrary thrown object
   content, hostile getters and collector/spool bounds. Use Node and Bun child
   processes against a local collector for off/no-write/no-network, fatal exit
   parity, handled rejection, outage/restart delivery and repeated crashes. A
   model call is irrelevant to the crash-delivery path; a real collector smoke
   is additional evidence, not a substitute for the negative controls.
6. **OpenCode scrub #18 — accept direction; verify the host boundary.**
   Full small diff reviewed. Current Meridian passes the resolved Claude model
   into the plugin, which is appropriate for GPT-request aliases actually served
   by Claude. Test that real path rather than only directly passing GPT strings
   into `onRequest`. Prove unchanged Claude scrubbing and byte-identical non-Claude
   prompts through an actual provider integration when available. Check arbitrary
   IDs containing `claude`, missing model, adapter instances and headerless
   passthrough. Build/install the package tarball in an isolated client gate.
7. **#1175 — recommend acceptance after the update-policy/health decision.**
   Separate useful version visibility from the policy change that makes registry
   checks off by default. `/health.build.latest` availability changes even though
   the field is optional. Resolve owner/API requirements, reconcile the header
   with #1171, and use a counting registry to prove zero calls while disabled,
   toggle races, timeout/cache behavior and force-off precedence. Browser checks
   at phone/desktop widths; real bundled process and registry smoke, no model call
   needed for this feature. Replace the unbounded documented readiness loop and
   fixed disposable-directory deletion with bounded isolated harness behavior.
8. **#792 — defer acceptance pending dedicated OAuth review and real sign-in.**
   It is now ready (not draft); the historical do-not-review status is stale.
   Current contributor evidence uses fake OAuth endpoints and explicitly lacks
   real-account OAuth and macOS Keychain validation. Review public callback state,
   PKCE lifetime/single use, forwarded-host trust, concurrent add/reauth, readonly
   mode and credential-store consistency. Rebase authored commits, retain separate
   corrections, then prove local callback and remote paste with isolated test
   profiles. Do not replace the user's active credentials. Track orphaned Keychain
   items and cross-process profile updates as explicit acceptance considerations.
9. **#1193 — defer pending contract and live cache/tool-safety proof.**
   The runner deliberately strips hooks and spawn-process interception before
   starting a forked SDK query. Prove that a keepalive cannot execute a native or
   client tool and that cancellation joins the subprocess before releasing its
   pin/permit; stopping after `message_start` is not by itself that proof. Verify
   credentials/profile changes, mapping/options consistency and foreground
   fairness. Its five-minute TTL premise also differs from #1187's claim of a
   one-hour subscription cache; establish the actual SDK/model cache policy and
   costs before scheduling periodic paid traffic. Require a retained real-SDK
   >10-minute idle/control experiment with cache read/write usage, unchanged source
   history through supported SDK APIs, same-session follow-up and E41 all modes.
10. **#1176 — defer until actual OpenAI-served upstream scope is established.**
    Upstream currently bridges Claude and Antigravity. The contributor explicitly
    cannot demonstrate the OpenAI-served path here. Pricing GPT aliases answered
    by Claude would be wrong; retain that negative control. Validate actual served
    model attribution before adding the maintenance burden of a second vendor's
    price catalog and scheduled PR workflow. Independently verify rates against
    primary sources when implementing, test cached/reasoning math, and ensure
    automation PRs can run required CI. No repository setting changes in this batch.
11. **#1171 — defer pending a bounded provenance scope decision.**
    Existing #866 provenance is already shipped; this adds certification counters,
    locks, worker observation and a new endpoint across 27 files. First decide
    which missing operator behavior warrants that complexity and how it composes
    with #1175. Then independently run build/source/npm drift, failed build,
    concurrent worktree, rollback and Windows packaging gates. Contributor final
    CI claims reference an older SHA than the live head; refresh exact-head CI.
12. **OpenCode scrub #5 — defer as written; preserve existing owner finding.**
    Full small diff and discussion reviewed. Minimal mode skips environment-block
    removal, contrary to the owner's July 10 report that the duplicate environment
    preamble was the actual extra-usage trigger. A corrected mode may preserve
    optional identity behavior while retaining required env cleanup. Rebase
    authored commits, add real current OpenCode/OMO fixtures, idempotence and
    passthrough controls, then reproduce the reported failing client flow with
    the implicated model. Do not claim the old contributor's vague local success
    establishes the current behavior.
13. **#1192 — defer until author completes observation and marks ready.**
    Currently draft; three-day observation began September 29 at 08:18 UTC.
    Revisit after October 2 at 08:18 UTC and updated evidence/ready status.
    Then reproduce deferred-tool budget-4 failure using the actual Opus/OpenCode
    path, retain the committed fixture gate as a deterministic adjunct, and run
    stream/nonstream, partial rejection, hidden-drop and uncaptured controls.
14. **#1050 — defer/outside implementation batch.** The author requests draft
    research only, no merge/release; Antigravity work has a separate owner lane.
    Revisit only on an explicit ready/scope change. Do not revive an old research
    branch over the current production implementation.

## Incorporation and proof contract

For each accepted item, fetch fresh main into a new `codex/` worktree and recheck
source head. Cherry-pick actual source commits, retaining Author and AuthorDate;
record source-to-delivery SHA mapping. Corrections and our harnesses are separate
maintainer commits. Do not replay a dependency twice or rewrite contributor work
under maintainer authorship. Full final-diff adversarial review precedes acceptance.

Every code delivery runs `npm test`, standalone typecheck and build, followed by
required final-head CI (including `test`). Match CI's Bun 1.3.11; distinguish
baseline failures from regressions. Affected model behavior needs real implicated
SDK/model/client/platform E2E, not merely mock success or a different model.
UI, registry and crash-reporting changes need their actual browser/process/network
flows; unrelated paid model calls would add no evidence. Preserve baseline/final
SHAs, commands, versions, deterministic assertions and limitations in the repository
or PR. Critical fixes retain a runnable headless harness. Missing live gates stay
open, while independent items proceed.

This request authorizes review, corrective incorporation and PRs. Merges/releases
are not performed here. If later authorized, recheck source/base/head, require
exact-head CI, squash normal PRs with `--match-head-commit`, and verify original
human credit in the squash. Source closure waits for unchanged contributor heads
and verified delivery. No community messages without explicit authorization.

## Source heads at inventory

| PR | Source head |
| --- | --- |
| [#1191](https://github.com/rynfar/meridian/pull/1191) | `34cca099bc8fdaf283631914fa1c1eaf6f1593c3` |
| [#1186](https://github.com/rynfar/meridian/pull/1186) | `9d33e45f4c88d24a633683f79f67b0bbf0eb1681` |
| [#1187](https://github.com/rynfar/meridian/pull/1187) | `5bbc96028f011b7bd1354d73e5d0a44396220266` |
| [#1190](https://github.com/rynfar/meridian/pull/1190) | `be7ad199b7614378b3499d20b16dab1021e5caed` |
| [#1189](https://github.com/rynfar/meridian/pull/1189) | `c2f4b67f92dcb181df12f2fc85c1fa32d5382997` |
| [#1193](https://github.com/rynfar/meridian/pull/1193) | `8fa4c80c9e219918e4006a03106c6226fcbebe86` |
| [#1175](https://github.com/rynfar/meridian/pull/1175) | `f1de050ed40e4d5d8b618319649f79601e7d4fed` |
| [#1176](https://github.com/rynfar/meridian/pull/1176) | `ac36a46312be783f92812efcd12069ebeb44ef27` |
| [#1171](https://github.com/rynfar/meridian/pull/1171) | `8b6e2ff482f756b80d5ed5db9ed1869ca892e87f` |
| [#792](https://github.com/rynfar/meridian/pull/792) | `47160ffe9a19cdf9fc38a2399d64f56210b0d1f6` |
| [#1192](https://github.com/rynfar/meridian/pull/1192) | `4e55f7de9d1bc52ddbb3d63b61aa13b5ee44ab15` |
| [#1050](https://github.com/rynfar/meridian/pull/1050) | `72c1ca91105a595b37dcf3e201cb93e523a8381f` |
| [OpenCode scrub #18](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/18) | `03d2f561f3c780d4935c9bbc9ef5135a3c8225f2` |
| [OpenCode scrub #5](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/5) | `40094cd9adaef32456befa54c1b969d611785395` |
