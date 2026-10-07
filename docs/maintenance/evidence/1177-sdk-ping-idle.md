# SDK ping idle deadline (#1177)

Accepted with maintained negative controls and durable actual-client proof.
Original authored commit `f261fc9e0259f6ac92157051e1bec38a19eeac77` by Nate
Berkopec is cherry-picked as `5f488d8e`, preserving Author and AuthorDate.
The issue's linked `b004b952` is a later packaging-only checkpoint, not the fix.
Retain current package metadata when resolving the fork version conflict;
separate maintainer `70385c83` removes the unrelated fork packaging workflow.
Base `b4d23428ea6b7dd9d7f4878e3fd59ad92bcb4e9f` includes #1208.

## Before and after

The original published 1.76.5 and unchanged main have identical guard blob
`b93ea333e1263b903dac074baf30942a480f5607`. The author's committed
`node scripts/repro-sdk-ping-idle.mjs` exits 1 before: four incoming pings,
120000 virtual milliseconds without model output, no timeout. It exits 0
after: upstream idle timeout at 90000 ms. This is a direct clock-based
regression, not real SDK/model E2E.

`E2E_PI_CLI=<installed Pi cli.js> E2E_CLAUDE_BIN=<Claude Code 2.1.283>
node scripts/e2e-pi-sdk-ping-idle.mjs` drives the actual headless Pi client
through bundled Node Meridian and actual SDK 0.2.141 / native Claude Code
2.1.283. Use Node 26.8.2 on macOS arm64 to match the reported platform/CLI.
The controlled local Anthropic API sends transport pings every 250 ms, then
valid model-shaped output at 35 seconds. Idle limit is compressed to 15 seconds;
no actual model or credentials are used in this fault probe. The original report
omits its Pi and model versions; installed Pi 0.87.1 is the exercised client.

Run the identical harness against compiled unchanged guard with
`E2E_EXPECT_STALL=0` for the negative control. Unchanged baseline `cc74cd2d`
(guard identical to published/main) completed after 35178 ms, 139 upstream
pings, no timeout, one assistant completion. Corrected final rebased bundle:
15007 ms, 59 pings, Pi received upstream_timeout, zero assistant completions.
Both probes exit 0 because they assert the corresponding opposite outcomes.
Pi itself exits 0 even when its JSON transcript contains the error; the harness
asserts that transcript and elapsed deadline, rather than treating exit as proof.
The first corrected probe was 14998 ms; final-base repetition matches it.

A separate real SDK/CLI 2.1.283 upstream probe observed six actual nested
stream_event/ping messages before message_start. Initial exploratory setup had
an obsolete cli.js path and ignored /messages?beta=true; corrected native binary
and URL pathname selection. A short 2.1.284 probe saw no_events, but its duration
was shorter: no version-dependent change is established. Do not infer that the
newer CLI fixes the bug or that a fake SDK iterator proves CLI event behavior.

## Live model and adjacent flow

`E2E_MERIDIAN_ROOT=<built checkout> E2E_CLAUDE_BIN=<2.1.283>
E2E_PI_CLI=<Pi 0.87.1 cli.js> E2E_PLUGIN_PATH=<installed Pi scrub entrypoint>
node scripts/e2e-pi-live-idle-control.mjs` uses actual Opus 5.5, SDK 0.2.141,
Claude Code 2.1.283, Node 26.8.2 on macOS arm64. The independently installed
Pi scrub tarball from Pi PR #14 preserves native prompt context and project
instructions. First turn: one actual read tool, private random result in the
SDK request, zero errors. Same Pi session file continuation: one assistant
message, zero errors. Both exit 0. Existing credentials are read-only and no
customer transcripts are used. This demonstrates adjacent live model operation;
it does not reproduce the reporter's unspecified live-model startup slowness.

## Adversarial review

Only nested stream_event/ping is discarded before lastAt/yield. Ordinary
model progress resets the deadline; top-level keep_alive remains unchanged,
disabled guard passes all events, malformed/other shapes pass through.
Downstream client SSE keepalives and teardown/cancellation remain unchanged.
Direct tests cover these boundaries. No public contract or process-gate bypass.
Critical runnable actual-client fault and live probes are committed in this
repository; private raw logs stay local and these sanitized outcomes are durable.
Final local gates and required exact-head CI are recorded on the integration PR.
