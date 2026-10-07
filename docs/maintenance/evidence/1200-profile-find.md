# Profile links and filtering

Accept #1200 with design corrections. Source `517c91bd1759c68151873e7391ef66ed2af7b013`
was incorporated as authored cherry `f90db029`, preserving Nowaker's Author and
AuthorDate. Links/search help find an account without changing routing or adding
server contracts. Current-main baseline is `cc74cd2dd65ec3a246512179fc7958a79a1bccd6`.

Retain the shared header, existing mobile fixes, micro-label section typography
from DESIGN.md, and the permitted blue tint. Add reduced-motion CSS for the new
anchor pulse. Use a null-prototype lookup for profile names, consistently with
profile ordering; no prototype-name failure is claimed.

## Reproducible browser gate

```sh
E2E_BASELINE_ROOT=<unchanged-main-checkout> bun scripts/e2e-profile-find.mjs
```

Open the reported /after/profiles URL with the collaborative browser. Evaluate
all of `scripts/e2e-profile-find-browser.js` as one expression; require result
PASS. The fixture serves actual templates, shared header and browser code with
14 synthetic account records. No credentials or model calls are involved: the
affected flow is account navigation, rather than an agent request.

At widths 320, 375, 800, 1280 the gate verifies former-name canonicalization,
a conflicting URL query cleared by the target anchor, alignment below the
sticky header, later header content growth, polling without scroll jumps,
search focus/value/query persistence, hidden reorder controls, literal search
markup, Escape clearing, and no horizontal overflow. Actual page/client widths
were respectively 301/301, 356/356, 781/781, 1261/1261 (browser scrollbar included).
A baseline control lacks the search box. Following the home signed-out account
link, including its key handler, navigates to the exact profile with zero
recorded state mutations.

An initial probe changed header padding, which is outside ResizeObserver's
content-box observation and does not represent the chip-content growth in the
app. It failed. A speculative frame-delay correction was removed: the corrected
probe appends header content and passes with the contributor's original timing
code. Do not cite that initial failure as an application regression.

Reduced-motion is covered by the added CSS rule; this browser API did not expose
OS preference emulation, so this record does not claim a live reduced-motion
preference test. Fixtures prove browser wiring, not external account login.
Final local full-suite/build/typecheck and exact-head CI are recorded in the PR.
