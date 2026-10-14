# #1224 restart drain: contract corrections and live check (2026-10-13)

Contributor PR #1224 by @Nowaker adds `POST /drain` and `DELETE /drain`. The
owner approved the route's contract in #1282 (bounded, keyed, best-effort hold).

## Maintainer commit on the contributor's branch

Review of the contributor's head `bf53e2590` against #1282 found these clauses
unmet, all fixed in one maintainer commit (`948336443`) on the PR branch, with
tests:

1. `/drain` did not require the configured API key.
2. A drain could start after shutdown began or after a cancelled body read.
3. The options body had no size or read-time bound.
4. Held requests had no limit; overflow now admits normally and is not counted
   as a cap admission.
5. Every Antigravity POST was held, including token counts and response
   cancellation; only generation submissions are now.
6. A session cancel could not reach an already-held request.
7. Held requests did not count for the idle-exit window (they stay out of the
   public `/inflight` `total`).
8. OpenAI translation routes could be neither held nor counted while their body
   was being read and translated.
9. Docs promised keyless access and that `total` reaching 0 makes a restart safe.

These corrections come from an earlier maintainer implementation of #1282 that
passed two independent reviews; only its product changes and tests were carried
over. Its harness and evidence were not.

Known limitation, not fixed: under Bun, a client that disconnects while held is
not released until the hold ends, because the request's abort signal does not
fire on disconnect there. Under Node (the launchd and npm paths) it is released
at once.

## Live check

`bun scripts/e2e-drain-live.mjs` (E74), Opus 5.5, macOS arm64.

| | Unchanged `main` `afd116e87` ([baseline-report.json](baseline-report.json), `--expect-baseline`) | PR head merged with `main` `613dd5adb` ([candidate-report.json](candidate-report.json)) |
|---|---|---|
| `POST /drain` | 404, no such route | keyless 401, keyed 200 `started: true` |
| Second request | runs beside the first (`total: 2`) | held (`total: 1`, `held: 1`), no SDK query |
| Idle window | none | `total: 0` with the second still held |
| After `DELETE /drain` | — | held request runs and completes, nothing left held |
| Result | PASS (baseline expectations) | PASS, 9 of 9 |

Local gates: `npm test` and `npm run build` with zero failures on the corrected
branch before and after the merge of `main` that brought in #1211 and #1373.

Not covered: a real restart supervisor, Linux, the Antigravity mount at runtime,
the idle exit actually firing.
