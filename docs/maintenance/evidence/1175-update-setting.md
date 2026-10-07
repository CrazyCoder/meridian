# Opt-in update checks (#1175)

Source `f1de050ed40e4d5d8b618319649f79601e7d4fed` incorporated as
`2a4ce5c6`, preserving Nowaker Author and AuthorDate. Maintainer correction
`76fba205`; base `310dd95698b27484ff5bc0feb88f59f365ef58c0`.
Owner-selected contract scope is tracked in #1226.

The setting defaults off, respects MERIDIAN_NO_UPDATE_CHECK, and exposes
optional health update information plus authenticated settings GET/PUT.
The shared header retains immutable runtime/disk provenance and displays
an npm package's version even when no update check runs. Registry updates
are distinct from local build drift. No coding-client/model behavior changes.

## Adversarial findings and controls

Disabling during asynchronous cache reading still allowed the authored
implementation to open a registry connection. A direct control failed on
the authored tree (22 pass, 1 fail); rechecking immediately after cache I/O
passes and starts zero connections. Generation fencing prevents a stopped
in-flight lookup publishing a result. JSON null submitted to settings threw
HTTP 500; the unchanged control failed (9 pass, 1 fail), then input validation
returns 400. API-key protection, malformed inputs, unset settings, environment
precedence, cache behavior and deferred lookup controls pass. Runtime banner
identity comes from the captured build rather than re-reading mutable disk.

## Actual HTTP and browser evidence

`npm run build && node scripts/e2e-update-setting-live.mjs` runs the bundled
Node server with isolated empty credentials/config/sessions and counts a
controlled loopback registry. On Node 22.22.3, macOS arm64:

- Off: zero connections and no cache file.
- On: exactly one connection, latest 1.99.0, updateAvailable true.
- Off: latest cleared; re-enable: cache hit, no second connection.
- Environment opt-out overrides the saved setting.
- Actual npm registry lookup returned 1.79.0; setting reset off.

Repeated after rebasing onto the combined build-provenance/request-activity
main. Both runs PASS. The collaborative browser drove the real settings
page: toggle on checked/enabled with up-to-date status, then off unchecked
with disabled status; local provenance retained and duplicate plain version
hidden. A separate synthetic npm header fixture at 1169 CSS pixels displayed
v1.79.0, hid local provenance and had no document overflow. The settings
caption distinguishes registry releases from local build identity.
No mobile viewport or actual future published update claimed.

Final combined local gates: npm test 5100 pass / 0 fail / 4 skip across all
16 isolated stages; standalone typecheck and build pass with Bun 1.3.11.
The maintained HTTP harness is durable proof; temporary logs alone are not
the evidence escrow. Final-head CI remains a merge gate.
