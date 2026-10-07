# OpenCode transient prefill recovery — #1242

Source [#1242](https://github.com/rynfar/meridian/pull/1242) at
`a2408b82ca4c05e8ed1c770b1ac72615ef1bdd85` was initially incorporated from main
`d57388724a242116f123ff75b88fd2be2846abe3` as `6912ec9f`, then rebased
onto main `802d9398f609eb49b4c93fe34c306b872ebeb647` as `37ade6ab`, preserving
Nowaker <spam@nowaker.net> and AuthorDate 2026-10-01T19:43:01Z.
Maintainer correction `f11c355b` (rebased as `a42c696e`) narrows recognition to the actual trailing
shape: one exact recovery text block after only tool-result blocks, after
recognized transient hooks are removed.

## Adversarial findings

The source correctly isolates OpenCode-specific behavior in its adapter and
changes only lineage hashing: the model receives the original request. It
recognizes the exact sentence emitted by the released oh-my-openagent
messages-transform hook. However, the original filter removed that sentence
anywhere in a user message containing a tool result, including before the
result or beside meaningful user follow-up text. A new regression assertion
failed against the source (16 pass / 1 fail). The narrowed filter preserves
those shapes while retaining recovery recognition across tool batches and
recognized hooks (18 pass / 0 fail). It preserves message positions and
surviving block identity. Standalone text, assistant text, different wording,
and ordinary tool results remain unchanged. No public interface changes.

## Actual affected-client before/after

Committed harness: `scripts/e2e-opencode-prefill-lineage.mjs`. The fixture runs
real OpenCode 1.18.34 on macOS arm64, the unmodified published
**oh-my-openagent 5.1.12** messages-transform hook, independently installed
scrub 0.2.3, Agent SDK 0.2.141 and bundled CLI 2.1.284, under Bun 1.4.2. It
observes the actual upstream model **claude-sonnet-4-6**, which is one of the
plugin's prefill-recovery triggers. Each read reveals the path to the next
file, yielding three actual tool rounds and a receipt assertion.

An isolated local wrapper exposes only the released messages-transform hook,
without modifying its implementation, to keep unrelated agent/tool/config
hooks out of the comparison. The client HOME/XDG/project/config are disposable;
startup sweep stamps prevent unrelated process sweeps. Credentials come from
the owned persistent native fixture and are never printed. This proves the
model-triggered recovery path, not a separate interactive compaction scenario.

| Assertion | Unchanged main | Corrected integration |
|---|---:|---:|
| Real client exits 0 and returns final tool receipt | pass | pass |
| Actual wire tool-result + recovery rounds | 3 | 3 |
| modified-history full replays | 2 | 0 |
| Real SDK queries | 5 | 5 |
| SDK queries with resume | 1 | 3 |
| Actual SDK account matches owned fixture | all | all |
| Native model observed | Sonnet 4.6 | Sonnet 4.6 |
| Inflight cleanup joins at 0 | pass | pass |

The initial untraced baseline attempt hid request logs with silent=true, so
its divergence-observation assertion was unavailable. Enabling the fixture's
captured logs resolved that instrumentation error; no product assertion was
relaxed. The first credential path had been removed from temporary storage;
no model call occurred in that attempt. Both successful runs used the same
persistent valid native credential fixture.

```sh
# Install the exact released plugin and its external zod dependency privately.
# Export E2E_PROFILE_CLAUDE_DIR, E2E_PLUGIN_PATH, E2E_OPENAGENT_ROOT,
# E2E_OPENCODE_BIN and use Bun 1.4.2. Do not print credential contents.
E2E_MERIDIAN_ROOT=/path/to/unchanged-built-main E2E_EXPECT_RESUME=0 \
  bun scripts/e2e-opencode-prefill-lineage.mjs
bun scripts/e2e-opencode-prefill-lineage.mjs
```

Source + maintainer correction full `npm test`: 5,130 pass, 0 fail, 4 skips.
Standalone typecheck/build pass. All four maintained E41 chain/parallel ×
JSON/SSE gates, final-head checks and CI results are recorded in the integration
PR before acceptance. The E41 assertions remain unchanged, including cache
continuity and supported SDK active-history inspection.


## Broader controls and base refresh

All four unchanged E41 modes pass on native Sonnet 4.6 with the same owned
account: chain JSON, chain SSE, parallel JSON and parallel SSE. They verify
exact tool batches, distinct durable forks, exactly one real result per
delivered call in supported SDK history, and full prior-prefix cache reuse.
The final maintained client harness run, including joined child cleanup,
passes with four actual recovery rounds, zero replays, six native queries and
four resumes. The number of model-driven rounds is observed rather than fixed;
the tool receipt, activation, actual wire shape and absence of replays are
asserted.

After test-only integration #1247 merged, this branch rebased onto `802d9398f`.
The adapter and product code are identical to the live-tested tree; the base
adds test isolation and its executor-ready fixture correction. Author/AuthorDate
are still preserved. Fresh full local gates and final-head CI must pass on the
rebased integration before landing.
