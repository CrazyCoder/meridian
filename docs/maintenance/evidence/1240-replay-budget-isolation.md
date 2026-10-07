# Replay-budget test isolation — #1240

Source [#1240](https://github.com/rynfar/meridian/pull/1240) at
`d868637455387e0359f1b3f4975caaf5fb1399ac`, authored by robertn702
<8119609+robertn702@users.noreply.github.com> on 2026-10-02T15:15:12Z,
is incorporated as `cbdd5d174c0566a283fc6b9c36cb775b624308b3` from main
`d57388724a242116f123ff75b88fd2be2846abe3`, preserving Author/AuthorDate.

## Findings

The reported process-global models mock still affects the real replay-budget
module when profile-switch test modules load first. The ordinary three-file
command on this host selected a harmless load order (28 pass). A disposable
ordered import fixture loaded profile-switch-inflight, then
profile-switch-integration, then replay-budget; filtering to `replay budget`
avoided running unrelated profile tests under the combined mock environment.
It reproduced exactly the two reported failures: `opus[1m]` received a 200k
window and a 20k reserve (11 pass, 2 fail). Running the original replay-budget
file alone passed all 13 assertions. Bun was 1.3.14, Node 22.22.3, macOS arm64.

The change excludes `**/*replay-budget*` from the shared stage and explicitly
runs `src/__tests__/replay-budget.test.ts` after models.test.ts. File inventory
confirms the exclusion currently matches exactly that test. It does not alter
application behavior, budget assertions, timeouts or model routing. It fixes
the supported npm test runner, not arbitrary combined bare-Bun invocations.
Other models mocks remain a broader follow-up; this does not resolve all CI
flakiness reports (#933/#917).

## Reproduction

In a disposable `ordered.test.ts` (absolute paths target the reviewed checkout):

```ts
await import("/path/to/checkout/src/__tests__/profile-switch-inflight.test.ts")
await import("/path/to/checkout/src/__tests__/profile-switch-integration.test.ts")
await import("/path/to/checkout/src/__tests__/replay-budget.test.ts")
```

```sh
bun test --timeout 30000 --test-name-pattern 'replay budget' /path/to/ordered.test.ts
bun test --timeout 30000 src/__tests__/replay-budget.test.ts
npm test
npm run typecheck
npm run build
```

No model call is implicated by this test-runner-only change. Final full-suite
and exact-head CI results are recorded in the integration PR before merge.

## Final-head CI finding and correction

The first integration head `7ad8afb36d3ffc52c5ca01e881128f4332816acd`
passed local npm test (5,125 pass, 0 fail, 4 skips), typecheck and build, but
[CI test](https://github.com/rynfar/meridian/actions/runs/37101134488/job/111140724616)
failed the orphaned SDK gate fixture. It killed the owner after
`spawnClaudeCodeProcess` returned, before asynchronous gate publication had
necessarily finished. The unopened wrapper then waited for its 60-second
publication deadline; the test incorrectly expected its supposed 1.5-second
child to have exited within 10 seconds. This is a test setup race exposed by
already-merged asynchronous SDK publication, not a replay-budget regression.

A disposable copy of the test delayed FileHandle.sync by 300 ms inside the
owned worker before gate dispatch. The old fixture deterministically failed
its exact-executor-dead assertion (10.098 s on macOS, indeterminate instead of
dead). The corrected worker waits for a file written by the actual executor
before reporting ready. The executor waits for a controlled release file;
the parent releases it only after proving the dead owner's lease remains
fenced. The same 300 ms publication delay passes (439 ms), and all five real
process lifecycle tests pass (33 assertions). No timeout or fencing assertion
was weakened; application code and the SDK gate contract are unchanged.

For the delayed negative control, create a disposable copy of
session-lifecycle-process.test.ts, pass an owned GATE_DELAY_PROBE path in the
worker environment, and insert this inside the worker immediately before
`gate.spawnClaudeCodeProcess`:

```js
const fsPromises = await import("node:fs/promises")
const handle = await fsPromises.open(process.env.GATE_DELAY_PROBE, "w")
const prototype = Object.getPrototypeOf(handle), originalSync = prototype.sync
await handle.close()
prototype.sync = async function () {
  await Bun.sleep(300)
  return originalSync.call(this)
}
```

Run the copied test with `--test-name-pattern 'orphaned real SDK gate'`, then
remove it. This observes the real asynchronous gate's publication boundary.
The integration PR records the final corrected head, full local gates and CI.
