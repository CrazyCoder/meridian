# Authorized backlog dispositions — 2026-10-01

Owner requested review of the PR/issue queue, contributor-preserving integration,
maintainer corrections and actual headless agent proof. This records the completed
review pass; deferred reports remain open. No release or external-message
permission was supplied. Repository rules require owner approval and an issue
for public interface changes; a contributor proposal is not itself that approval.

## Coverage and delivered work

Initial paginated inventory: 18 Meridian PRs / 11 issues, two OpenCode scrub PRs,
and Pi scrub issue #13. Accessible owner and organization discovery covered
Meridian and all five owned scrub repositories: OpenCode, Pi, Hermes, OpenClaw,
hudscrub. All have owner ADMIN permission; no other accessible scrub candidates
were found. Fresh owner listing and Centeva/pylon-code organization listings
again found no additional scrub candidates on October 1. The user's dirty
checkout at `446a0f163` was preserved throughout; all changes used isolated
branches. The [handoff](REVIEW_HANDOFF.md) records delivery/source SHA mappings,
merge-tree equality, contributor credit, local/final CI and proof limits.

| Source | Disposition and delivery | Concrete behavior/evidence |
| --- | --- | --- |
| Meridian #1191 | Accept, merged #1196 | Pricing table scrolls internally on phones; failing CSS-removal control and desktop parity. |
| #1197 | Accept, merged #1203 | Health stops waiting on stale-auth CLI refresh; real CLI delay and OpenCode continuation. |
| #1186 | Accept with correction, merged #1204 | Copy-on-write store avoids needless serialization; correct nested ownership/freeze and exposure; actual OpenCode receipts plus E41. Reported overloaded Linux 40-second symptom not independently reproduced. |
| #1198/#1199 | Accept with correction, merged #1205 | Phone layouts/favicon assets; restore sort wrap; 28 browser cases and compiled Node HTTP assets. |
| #1189 | Accept with correction, merged #1206 | Crash reporting retains Node rejection-policy semantics and scrubs error names; 22 process configurations and four actual compiled CLI collector cases. |
| #1200 | Accept with correction, merged #1207 | Profile anchors/search match design and reduced-motion rules; actual browser matrix, focus/scroll/poll/reorder and no mutation following link. |
| #1192 | Accept, merged #1208 | All relevant deferred-tool refusals recover; actual macOS/Linux OpenCode with SDK/CLI controlled fault plus live Opus read receipts/continuations. |
| #1177 | Accept authored fix with maintainer controls, merged #1209 | Nested SDK ping does not count as progress; actual Pi/SDK/CLI ping-only fault times out at 15 seconds instead of waiting 35 seconds, with adjacent actual Opus tool/continuation control. |
| Pi scrub issue #13 | Accept, merged Pi PR #14 | Remove whole header-scoped docs section; published/current failures, real Pi 0.87.1 tool receipt and continuation via independently installed tarball. |
| OpenCode scrub #5 | Accept with correction, merged scrub #19 | Minimal mode retains required environment dedup/cwd/current OMO guards; 28 tests, default parity, real OpenCode 1.18.33/Opus 5.5 tools and continuation in both modes, independent tarball. |

CSS/UI changes use actual browser proof; SDK/client changes use headless agent
flows. Every merged behavior change has durable evidence and relevant final-head
CI; no unexecuted release is claimed. Remaining features were read in full,
including commits/discussion/current main/callers; green contributor tests do not
replace the product or live gates below. Static concerns are labeled separately
from reproduced defects.

## Remaining PRs

All source heads below were refreshed after deliveries. “Defer” means retain the
source and explicit next gate, not a claim that its behavior is bad or resolved.

| PR and exact reviewed head | Disposition, product fit and findings | Observable revisit trigger |
| --- | --- | --- |
| [#1201](https://github.com/rynfar/meridian/pull/1201), `30e01969c4511cc21e3a46c76d35c615a5ac6466` | Defer affected-client proof. Accepting settled per-call echo/result pairs plausibly improves Responses client interoperability while strict tool-result association must survive. Public client is Meowbert, `XInTheDark/meowbert-ai-agent`; its `08e771a948d6d9db1fe96fee93c9ed7d54068cf4` already changes the caller to record all calls before outputs and names only “Opus”. The owner does not know the exact model. Current fixed Meowbert success would not reproduce the original bad ordering. | Original worker/runtime configuration and exact model, actual Responses headless Meowbert worker before/after with parallel calls and correlated result receipts, plus negative unrelated/duplicate/missing-call controls. Keep original missing evidence explicit; no further owner guess required. |
| [#1193](https://github.com/rynfar/meridian/pull/1193), `7c9308968f760119e1b9f3ba8d74497af39d4a85` | Defer contract/lifecycle proof. Opt-in cache warming could reduce idle costs, but introduces public `x-meridian-cache-keepalive` semantics and background model calls. Proposed five-minute universal TTL is unverified for the implicated subscription runtime. Static review: raw SDK warm forks lack the normal process/hook gate; close releases reservation/pins before joined termination. These are review findings, not reproduced runtime races. | Owner-approved tracked contract, joined writer/process shutdown and normal admission fences, actual implicated-model cache measurement across idle period with off/on control, concurrent-turn/GC cancellation proof. |
| [#1190](https://github.com/rynfar/meridian/pull/1190), `be7ad199b7614378b3499d20b16dab1021e5caed` | Defer public drain contract. HTTP request counts can help operators, but public `/inflight` counts only selected client HTTP lifetimes, not standalone Antigravity or detached Responses jobs. A zero snapshot cannot establish safe restart or absence of future work. Source checks real socket loopback instead of trusting forwarded headers, which is appropriate. | Owner-approved tracked scope naming exactly what is counted, pending/detached-job accounting or explicit bounded HTTP-only semantics, actual headless client drain/restart/cancellation proof. |
| [#1187](https://github.com/rynfar/meridian/pull/1187), `5bbc96028f011b7bd1354d73e5d0a44396220266` | Defer destructive lifecycle policy. #1186 optimization already delivered; the second authored commit introduces default 24-hour deletion of cross-profile SDK copies. Static review: exists checks and unlocked sidecar operations do not establish cross-process leases; concurrent sweepers may each spend half-budget before reconciliation. Flattened replay after returning to a profile is not equivalent to native resume/thinking/context. No race or live resume-equivalence claim established. | Explicit default-policy decision, cross-process lease/multi-sweeper proof, actual two-profile copy/prune/return flow including resume versus replay, source commit separation preserving authorship. |
| [#1176](https://github.com/rynfar/meridian/pull/1176), `ac36a46312be783f92812efcd12069ebeb44ef27` | Defer unsupported backend. GPT list-price valuation and its automatic data updates target a ChatGPT subscription backend absent from main. Codex-to-Claude usage is not evidence of OpenAI-served GPT billing. | Supported ChatGPT backend lands, actual OpenAI-served headless usage/aliases match, current authoritative prices are verified. Do not merge speculative rates alone. |
| [#1175](https://github.com/rynfar/meridian/pull/1175), `f1de050ed40e4d5d8b618319649f79601e7d4fed` | Defer policy/API decision. Version chip is useful; changing update checks to default-off, adding public settings GET/PUT, and changing health metadata requires an approved contract and coordination with #1171. Generation cancellation suppresses late UI publication, but started registry work/cache write can outlive disable; do not call that a reproduced defect. | Owner-approved tracked update/default/health contract and scope relative to build provenance, actual enabled/off registry control and browser/health compatibility proof. |
| [#1171](https://github.com/rynfar/meridian/pull/1171), `8b6e2ff482f756b80d5ed5db9ed1869ca892e87f` | Defer #1170 public provenance contract. Immutable loaded build identity is useful, but introduces `/build-status`, health metadata, persisted worktree counters and a broad observer. Static review: module-import snapshot synchronously walks tracked/unignored untracked files; large dirty checkout responsiveness is unproved. Contributor's Linux three-build proof is evidence, not authorization or packaged-runtime coverage. | Owner-approved #1170 loaded/runtime/artifact/source contract, actual packaged startup and worker/large dirty checkout responsiveness, worktree/rollback counter/browser proof; align with #1175. |
| [#792](https://github.com/rynfar/meridian/pull/792), `47160ffe9a19cdf9fc38a2399d64f56210b0d1f6` | Defer account-management contract and correction. Useful browser login adds six public routes/callback PKCE/account creation/native keychain behavior. Reproduced source page dictionary defect: valid profile IDs `__proto__` and `constructor` are treated as inherited login/minting entries and never mint a link. Cross-process profile-file mutation remains acknowledged/untested; fake OAuth Chromium tests do not prove real-account/macOS keychain behavior. | Approved tracked OAuth/account contract, prototype-safe dictionaries/meaningful browser cases, authorized disposable real-account/native keychain login, cross-process persistence and callback cancellation/concurrency controls. No real-account login was initiated. |
| [OpenCode scrub #18](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/18), `03d2f561f3c780d4935c9bbc9ef5135a3c8225f2` | Defer unavailable affected provider. Claude-only guard plausibly preserves non-Claude contexts; core supplies the resolved model so a client GPT alias mapped to Claude is correctly scrubbed. Actual non-Claude/ChatGPT provider path required by this proposal is not supported in main. Source pure tests are not provider/client E2E. | Supported non-Claude backend exists and actual same-client headless Claude/non-Claude flows prove unchanged non-Claude prompt and retained Claude runtime dedup. |

### Reproduced #792 dictionary failure

Source `src/telemetry/profilePage.ts` uses plain `{}` dictionaries and truthiness
checks in `ensureLoginLinks`. Exact JavaScript lookup behavior is reproducible
without an account or credentials:

```js
const loginLinks = {}, mintingLinks = {};
const minted = [];
for (const id of ['ordinary', '__proto__', 'constructor']) {
  if (loginLinks[id] || mintingLinks[id]) continue;
  mintingLinks[id] = true;
  minted.push(id);
}
console.log(minted); // ['ordinary'] — both valid special IDs skipped
```

Use null-prototype dictionaries or a Map if incorporating; test both special
IDs through actual link UI and retain ordinary duplicate-request protection.
No claim that PKCE state transfer alone creates a security bug; public callback
transfer is part of the design and needs the specific approved account contract.

## Issues in newest-first order

Fresh open issue inventory now has nine Meridian issues and no scrub issues.
#1177/Pi #13 were resolved by validated deliveries; #1009 is already closed on
GitHub at `2026-10-01T07:23:33Z` by owner, and is recorded separately without
attributing closure to this batch's different refusal recovery.

| Issue | Disposition and existing coverage | Observable revisit trigger |
| --- | --- | --- |
| [#1170](https://github.com/rynfar/meridian/issues/1170) | Defer contract, linked #1171. No owner approval inferred from Nowaker's issue. Immutable runtime identity useful; broad observer/API proposal not yet accepted. | Approved provenance scope plus #1171 gates above. |
| [#1094](https://github.com/rynfar/meridian/issues/1094) | Already partly covered by #1148 in 1.76.5+: exact 2.0.16 setup/plugin port and real 15-request Sonnet gate on macOS/Linux are documented by existing owner decision. Defer the separate content-specific billing report; no captured sanitized block is available. Broad unpin would remove the boundary guarding a demonstrated host API break. | Sanitized fragment still fails under same-window active control, exact scrub config/version, actual affected 2.0.16 client E2E; qualify each new host before expanding pin. |
| [#1073](https://github.com/rynfar/meridian/issues/1073) | Defer to existing dedicated Antigravity implementation lane. Issue has explicit owner authorization and expansions; this queue should not duplicate/rewrite that ongoing work. Research draft #1050 still explicitly says no merge intended. | Existing lane assigned/review handoff, production candidate and official CLI/platform/client evidence. This pass did not land draft research or issue a release. |
| [#1068](https://github.com/rynfar/meridian/issues/1068) | Existing documentation #1163 covers safe append-only snapshots and precisely bounded `<system-reminder>` hashing. Defer new opt-in advisory contract: owner is open to review, not a finalized header/removal interface. Hash filtering cannot make the upstream session forget prior content. | Explicit approved retention contract, actual Pydantic AI 2.45.0/Harness implicated flow, rollback/restart/concurrent-turn/tool-result controls; retain ordinary history-edit rejection. |
| [#1011](https://github.com/rynfar/meridian/issues/1011) | Abort diagnostics already delivered #1022. Respect explicit owner hold on authored empty-capped-stream recovery `c5804275`: changes documented failure guarantee and stream/non-stream parity. #1192 refusal recovery does not authorize lifting empty/thinking caps. | Owner decides parity/new failure contract, both-mode capped-turn live gate and single-envelope SSE proof. Preserve actual author if resumed. |
| [#933](https://github.com/rynfar/meridian/issues/933), then [#917](https://github.com/rynfar/meridian/issues/917) | Defer remaining unexplained CI singleton causes. Existing #935 fixed transcript ceiling cluster; subsequent measured timeout controls are partial coverage. This batch isolated the store timing gate in #1204. On #1207 an unchanged Antigravity one-second probe failed once under full-suite load; baseline/focused pass and later full pass are explicitly insufficient proof of general resolution. No blanket timeout or bypass shipped. | Capture a failing final-head full-suite run with complete ordering/error body and deterministically reproduce its actual cause under the same platform/Bun/isolation settings, then a meaningful regression control. Keep both reports open. |
| [#769](https://github.com/rynfar/meridian/issues/769) | Official OpenClaw plugin already exists; latest owner #3 docs correct universal-classifier claims. Defer unknown new moving fingerprint. Native threading/context costs must be preserved where possible; arbitrary deletions are not a verified fix. | Private/sanitized affected fragment with still-failing same-window off/on/off control, exact OpenClaw/model/auth/version, actual client proof; no raw customer prompts or new broad rule guessed. |
| [#650](https://github.com/rynfar/meridian/issues/650) | Receiver and sender workflows already exist. Fresh secret-name listing for Hermes/OpenCode/Pi has no `MERIDIAN_DISPATCH_TOKEN`; existing actions intentionally no-op without it. Defer external credential provisioning; no useful dispatch proof can be obtained with a missing token. | Owner provisions scoped PAT/App credential, then sender workflow triggers receiver `repository_dispatch` end to end. No token minted or secret value read. |

**Closed #1009 has retained evidence limits.** Source feature is already landed,
default off; historical body still describes a canary/positive abort-window and
non-stream parity gate. Current issue has no new comment supplying that proof.
Do not infer the streamed-but-uncaptured abort-window path from #1192's captured
refusal coverage or enable the flag. Respect current owner closure without
claiming those historical gates completed in this review pass.

## Refresh and stopping boundary

After all behavior merges: Meridian has eight reviewed deferred contributor PRs
(#1201/#1193/#1190/#1187/#1176/#1175/#1171/#792), dedicated draft #1050, and
Release Please #1202; nine issues above remain open. OpenCode scrub retains #18;
Pi Release Please #15 and newly generated OpenCode Release Please #20 remain excluded
because release authorization is separate. Hermes/OpenClaw/hudscrub queues are
empty. A documentation delivery PR for this disposition record is tracked
separately from the source queue.

Every actionable accepted change is delivered and verified; every remaining
report has a concrete observable revisit trigger. The authorized review pass is
complete when this checkpoint passes required CI and lands. The GitHub queue is
not empty and deferred behavior is not advertised as fixed. Resume on changed
source/evidence or explicit contract/lane/release decisions rather than replaying
stale green checks. No external comments/messages were posted.
