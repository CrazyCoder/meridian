# Opt-in crash reporter review and proof

Source #1189 `c2f4b67f92dcb181df12f2fc85c1fa32d5382997`, authored by
Nowaker <spam@nowaker.net>, AuthorDate 2026-09-28T05:48:24-05:00.
Initial authored cherry-pick `6b69fd2922b0b3a5d56e030d2ba11b01fa27e8f9`.
Subsequent rebase mappings and final gates are recorded in the delivery PR.

Disposition: accept with correction, subject to final tests/CI. An explicitly
configured collector is useful for unattended Meridian instances; reporting
remains off without a DSN. Complete diff reviewed, including process hooks,
CLI/server wiring, privacy boundary, envelope construction, atomic spool claims,
retry behavior, file permissions, bounded storage and detached process packaging.

## Reproduced material findings

1. `Error.name` reached `exception.type` without scrubbing or a length bound.
   The source event builder reproduces `baselineNameLeak: true` for a synthetic
   Bearer value. Maintainer correction scrubs and bounds the exception type,
   including causes. Direct regression checks the actual envelope before spool.
2. An unconditional sole-listener rethrow changed Node's configured rejection
   policy. On Node 22.22.3, source behavior:

| Policy | Reporter off | Authored reporter on |
| --- | --- | --- |
| throw / strict | exit 1 before timer | exit 1 before timer |
| warn / none | timer fires, exit 0 | exit 1 before timer |
| warn-with-error-code | timer fires, exit 1 | exit 1 before timer |

   Corrected policy reads validated runtime options, with CLI flags overriding
   NODE_OPTIONS. Fatal policies rethrow; warning/none policies survive; the
   sole-listener warning-with-code policy preserves exit code 1. A strict-mode
   monitor observation prevents double reporting when the actual Meridian
   handler recovers before Node emits the rejection event.

A warning-mode reporter listener can suppress Node's automatic warning output;
the corrected claim is preservation of process survival and exit status, not
byte-identical stderr. Existing recovering handlers retain their own logging.
Reporting performs one synchronous spool write before delivery and can add
filesystem latency; it does not promise literally zero blocking work.

## Escrowed real-process gate

```sh
npm run build
bun scripts/e2e-error-reporting-policy.mjs
```

Uses the actual Meridian process error handlers, Node 22.22.3 and Bun 1.3.11 on
macOS arm64. Compiles the retained child fixture, runs real processes with
isolated settings/spool directories and a real local HTTP envelope collector.
No SDK query or model call is implicated by this process-lifecycle feature.

PASS: 22 paired configurations: all five Node policies, direct CLI flags and
quoted NODE_OPTIONS, with/without actual Meridian recovery handlers; Bun's
normal rejection behavior with/without recovery. Reporter-on/off survival,
recovery marker and exit code match. Exactly one event reaches the collector
per reported error, with correct path and synthetic secret markers absent.
The natural-exit fixture explicitly avoids `process.exit(0)`, which would mask
warn-with-error-code. Initial forced-exit harness results are not relied on
for that policy.

PASS: actual compiled `meridian test-error-report` under both Node and Bun.
Reporter off: exit 1, zero deliveries; reporter on: exit 1, one test envelope.
These four real CLI cases establish the compiled command's wiring independently
of the policy fixture. No external GlitchTip/Sentry account was used; the local
collector validates the transport, not a third-party UI or ingestion service.

Focused tests: 18 pass / 0 fail, including real fatal exceptions, rejection,
recovering handlers, detached delivery, collector outage/restart, malformed
DSN and reporting-off controls. Final full-suite, build, typecheck and exact-head
CI results remain recorded in the delivery PR before acceptance.
