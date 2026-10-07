# Responsive pages and approved wide layout (#1251 / #1252)

Disposition: accept both current Nowaker contributions with a separate phone
header correction. Owner explicitly approved authenticated GET/PUT
/settings/api/layout and contained/wide/null-reset persistence under #1254.
No release is authorized. Base: 93d6c5c97daf9f21778cf5e6ecf90f12d53f40cb.

The default retains the contained layout. Wide serves a root data-layout
attribute before page scripts execute, shares the header gutter and fits more
accounts across large monitors. Phone pricing identifiers stay on one line
inside the table's existing scroll area; narrower rate fields retain their
values. Home cards regain space on phones. Header provenance compresses from
full details to commit/run/version while keeping its complete tooltip and
warning/update chips. Existing tokens and the shared header remain in use.

## Authored source and separate corrections

All six original Author/AuthorDates are retained. The browser-login test
conflict preserves both sets of assertions; it does not drop the merged flow.

| PR | Source | Incorporated |
| --- | --- | --- |
| 1252 | bf350a84cc2a9bd9381c44c440814187f86ebffd | 825b67db1300f2e44aa8683275bfd97944bf8301 |
| 1252 | bf05e5bbe424558d0aa690bce5cf09b01f4cfe31 | 980f747ce94a43c9bc84c82d46bf994f8c0f48dc |
| 1252 | 1bd637cbb95e97a75afded8bd7254ad962fe3c89 | fdc0d5432a0787e660a160ce2b8e10adfe9a833b |
| 1252 | 3d02224d891d839229ba0eb318b2e8e061d8b9e6 | d194af0ce7c0dffd4372702c313ee4d416b3004a |
| 1251 | 827887eff0b4c10adda5b555de73ea05ca183ce1 | f829946efda9359b63ea8c69dfec72996fad3349 |
| 1251 | 74ac9017582d900d84f1a59b29f65c3870a6304f | 40c2d67d76521e5eabadde273ef6f3c57c6e8c0d |

Native macOS scrollbars exposed a source-only header defect: even version-only
provenance left the health dot on a second row at 375px. Maintainer b991eee1
adds a last-resort bounded account-name width, preserves its full name in the
tooltip, and keeps the API-type label unbroken. At the same viewport the
corrected header has one status row. Warning/update chips are never removed;
when all cannot fit they wrap instead of disappearing. Desktop geometry of
all 169 existing home elements is exactly unchanged, excluding newly added
invisible provenance spans and the account-name wrapper.

## Actual browser and HTTP proof

Pylon native Chrome 152.0.7977.130 / Electron 44.4.2 on macOS arm64, Bun
1.3.14. Outer preview resizing repeatedly timed out; a maintained same-origin
iframe supplies actual CSS viewports, and native innerWidth is asserted.
These are desktop Chromium responsive-layout tests, not iOS Safari/Android
or physical OS drag automation. SDK/model generation is not in these UI flows.

- Native 320/375/414/768/1280 before/after matrix: no new page overflow,
  pricing model names reduce from 5–6 lines to one, input widths 84 to 65px
  with no clipped values. At 375px the home card grows 312 to 344px with
  native scrollbar space; edge/card padding changes 24/18–20 to 8/9–10px.
  Normal status rows reduce to one on all phone widths. Warning and update
  visibility and complete account/provenance tooltips survive.
- Live resize through 375→414→768→1280→768→414→320→375 restores the largest
  fitting provenance and desktop spacing in both directions. Before/after
  screenshots and a short resize video were inspected: synthetic account
  names only, no credentials/OAuth. Pylon retains the local media; it is not
  represented as an uploaded GitHub artifact. Durable measurements and the
  exact runnable fixtures are committed beside this record.
- Actual app/settings I/O with 14 explicitly synthetic API accounts:
  home columns contained→wide at 1280/1920/2560 are 2→3 / 2→4 / 2→6;
  Profiles columns 1→2 / 1→3 / 1→4. At 375px both remain one column. Header
  and content gutters match in wide mode; no page overflow in either grid.
- The real Settings selector immediately applies and saves contained/wide.
  Every main HTML route returns the wide root attribute before scripts run.
  Invalid values return 400 and preserve the setting. The maintained HTTP
  harness additionally proves unauthenticated GET/PUT 401, allowed-key save,
  real settings.json persistence, null removing the stored field, default/reset
  contained pages, and standalone Antigravity / and /providers stamping.
- The maintained browser interaction script passes against the real app:
  keyboard reorder across a grid row saves and restores focus; DOM-dispatched
  drag across rows saves and clears marks; search isolates its account; the
  account anchor targets its card; switching updates persisted active profile
  and active card. Wide mode survives all these operations. These events drive
  the actual native browser handlers and HTTP writes with owned fixture IDs.

The initial live-app fixture unexpectedly read host plan metadata through an
existing API-profile native-store fallback. That initial fixture is not used
as synthetic evidence. The maintained fixture explicitly mocks native-store
and auth-status boundaries and forbids SDK queries/model endpoints; all layout
and settings paths remain the actual application. The existing API-profile
metadata isolation issue is a separate follow-up, not a layout regression.

Final local gates: npm test 5,296 pass / zero failures / 35 platform skips
across all 17 stages including pretest typecheck; separate typecheck/build
pass. Focused source/composition/auth controls: 53/53. Maintained actual HTTP
and browser interaction scripts pass. Required final-head CI, exact merged
tree, verified human co-author credit and fresh source heads remain gates.

Reproduce with `bun scripts/e2e-mobile-header-pricing-tiles.mjs` and
E2E_BASELINE_ROOT pointing to unchanged main, then evaluate its browser probe
inside the native fixture frame. `bun scripts/e2e-page-layout-live.mjs` hosts
the actual app with synthetic boundaries. Select wide and evaluate
scripts/e2e-page-layout-browser.js inside its 2560px Profiles frame.
`bun scripts/e2e-page-layout-http.mjs` independently exercises the real HTTP
apps and file-backed settings. Sanitized results are retained in this directory.
