# Mobile account layout review and proof

Source #1198 `959dc6c57171fab8a411ea7b5381c6e046633b2d`, incorporated as
`01d37638`; source #1199 `b6cb22e0610956fc1b12cd6300d787db53a79899`,
incorporated as `503ba3c0`. Both authored by Nowaker <spam@nowaker.net>;
Author and AuthorDate preserved. Initial base `98c48c03f`.

Disposition: accept with correction. Full source diffs, page renderers,
shared header, tooltip/focus, routing and rename controls, icon packaging and
Antigravity asset route reviewed. Useful behavior: long names, badges and
values wrap while all controls remain available. Existing page markup and
shared design tokens remain authoritative. No model behavior changes.

A first real browser comparison found the authored landing fix still overflowed
at 320 CSS px: sort tabs reached 326 px in a 305 px client area. Maintainer
correction wraps the account section heading and its sort controls. The same
browser assertion fails before that correction and passes afterward.

## Reproducible real DOM comparison

```sh
E2E_BASELINE_ROOT=<unchanged-main-checkout> bun scripts/e2e-mobile-layout.mjs
```

Navigate the collaborative browser to the printed URL and evaluate the entire
expression in `scripts/e2e-mobile-layout-browser.js`. Uses actual page templates
and synthetic account API fixtures; no user account data, credentials, model
calls or DOM stubs. Baseline used `c04a861ba`; intervening health changes do not
change page templates. Three synthetic accounts cover long identifiers,
active/follow/update chips, pool position, refusal, needs login, usage and cost.

PASS: 28 rendered page cases (baseline/final × home/profiles × seven widths).
Client areas below exclude the browser's 15 px vertical scrollbar.

| CSS width | Client width | Baseline home scroll | Baseline profiles scroll | Final both scroll |
| --- | --- | --- | --- | --- |
| 320 | 305 | 733 | 600 | 305 |
| 375 | 360 | 733 | 600 | 360 |
| 480 | 465 | 733 | 600 | 465 |
| 721 | 706 | 1034 | 1034 | 706 |
| 800 | 785 | 1034 | 1034 | 785 |
| 908 | 893 | 1034 | 1034 | 893 |
| 1280 | 1265 | 1265 | 1265 | 1265 |

At each final width: all three cards exist, narrow keyboard-focused details
popover remains inside the viewport, sort activates and retains keyboard
focus, rename opens without overflow and cancels. Baseline must reproduce
>100 px overflow or the probe fails. Synthetic fixture observations cannot
establish every possible account combination; unusually long arbitrary plan
labels remain outside this finite matrix.

Captured synthetic-only before/after screenshots and a short collaborative
browser video; final screenshot visually inspected. No GitHub media upload
capability is exposed in this session, so media is retained locally and is not
claimed as a durable PR artifact. The committed probes and numerical evidence
above provide the durable reproduction record.

## Compiled Node asset path

`npm run build && node scripts/e2e-packaged-favicon.mjs` passes on Node 22.22.3,
macOS arm64: six actual built-server pages link `/telemetry/icon.svg`; real HTTP
icon status 200, SVG MIME and body. Isolated config/state, no plugin execution.
The initial harness used Bun's immediate listening assumption; corrected it to
await Node's listening event and use the actual ProxyInstance.close lifecycle.
Source and bundled-layout direct tests also pass. Antigravity's same-path
asset route has a mocked CLI HTTP integration test; no live Antigravity model
call is claimed or needed to validate a static asset.

Focused tests: 28 pass / 0 fail. Build and standalone typecheck pass; final
full-suite and exact-head CI results are recorded in the delivery PR.
