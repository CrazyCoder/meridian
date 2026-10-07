# Browser account login incorporation (#792)

Status: real new-account creation, fresh automatic existing-account re-authentication
and actual headless use verified. Final-head CI and integration remain gates.
Tracked API scope: [#1215](https://github.com/rynfar/meridian/issues/1215).
Current source head: `a9abcce8c693dae018ff73872051a9dfeabe21b6`. The four Nowaker
commits were cherry-picked with Author/AuthorDate intact; maintainer fixes are
separate. The user's dirty checkout was preserved.

Product fit: browser re-authentication and explicit new-account creation
remove the need for a shell on the server. Unknown login IDs remain refused;
creation uses its own guarded route. PKCE verifiers stay server-side, state
checks precede exchange, read-only instances refuse credential writes, and
new credentials are isolated until the account slot is published. This
changes authentication flows, not merely usage accounting.

## Concrete findings and before/after proof

1. The authored page used plain object maps. Valid IDs `__proto__` and
   `constructor` inherited truthy entries and never received login links.
   The emitted-page VM regression failed before the correction. Actual
   collaborative-browser DOM inspection confirmed both disabled links before,
   then all four fixture accounts enabled afterward. The three maps now have
   null prototypes. Existing profile search/sort behavior remains in the page.
2. Two actual Node processes could both successfully create distinct accounts
   from one stale snapshot, losing one account. Same-name creators could both
   report success with different credential directories. The maintained
   `e2e-profile-creation-concurrent.mjs` fails in both modes against the
   authored implementation and passes after the shared writer-lock fix.
   Creation, OAuth-token CLI add, remove and rename now read and publish under
   one cross-process lock. HTTP lock waits yield to the event loop. Publication
   is atomic and malformed existing files are refused. Read-only existing
   file refusal and rename rollback remain covered. Interrupted writers fail
   closed; manual lock cleanup requires stopping all writers.
3. A macOS `execFile` failure included `security -w` password arguments in
   debug logs. The maintained `e2e-keychain-write-log.mjs` uses the actual
   compiled credential store with a controlled failed OS command. Its
   baseline reports `secretLeaked: true`; the correction reports
   `secretLeaked: false`, while preserving the failure event and numeric exit
   code. Only synthetic credentials enter that probe.

4. During actual sign-in, returning from Claude reloaded the page and discarded
   the in-memory creation handle, leaving the returned code without its form.
   The emitted-page regression failed before the correction (`stored.size`
   zero instead of one). Pending metadata now stays in tab-scoped session
   storage until completion/cancel/expiry. It contains only the opaque handle,
   public authorize URL, profile name and expiry, never a pasted code/token.
   An actual collaborative-browser reload restored the correct account form
   with an empty code field. Expired, malformed-name and unsafe-URL controls
   are discarded; disabled-storage browsers keep a usable live form and see
   a notice to retain that page. The initial real grant was not exchanged; a
   fresh grant was subsequently completed as described below.

## Verification recorded so far

- macOS arm64, Node 22.22.3, Bun 1.3.11: profile-page regression, focused
  profile/login/OAuth/rename/config-store tests, typecheck and build pass.
- Linux arm64 Docker: 200 focused tests pass, zero skips/failures. Both
  independent-process creation modes pass and the actual file-backed native
  credential round trip passes.
- macOS actual Keychain write/read round trip with a synthetic grant passes,
  using a unique directory-derived service; the probe deletes only its item.
  Platform-specific credential-file assertions skip macOS deliberately; Linux
  checks them without skips.
- Full npm test after writer-lock and credential-log corrections passed:
  5,130 pass, zero failures, 35 platform skips. Final full repetition after
  the navigation correction: 5,135 pass, zero failures, 35 platform skips.
  Standalone typecheck and build also pass.
- Actual browser authorization completed new-account creation after a page
  reload. The returned code/state matched the retained form and was transferred
  directly in the browser, without appearing in chat. The isolated account was
  published and its credentials stored in its own macOS Keychain service.
- Maintained `scripts/e2e-profile-login-client.mjs` passed twice using that actual
  newly created account: macOS arm64, OpenCode 1.18.34, Opus 5.5, SDK 0.2.141,
  Claude Code 2.1.284, Bun 1.3.11, independently installed scrub 0.2.3. A real
  client tool reads a unique receipt, then the same session recalls it without
  tools. Both client invocations exit zero; all four real SDK queries use the
  new account directory and a query resumes. The second run observes actual
  upstream assistant messages confirming `claude-opus-5-5`.
- Snapshot support recovered after earlier automation errors. No saved visual
  evidence of real credentials or authorization codes is captured. DOM
  before/after measurements establish the synthetic page regression.
- Existing-account re-authentication is still pending. An expired attempt and
  an authorization request containing `code=true` are not completed grants.
  The automatic loopback redirect has not been observed; no success is claimed.

Reproduction scripts and commands are retained in the repository and E2E.md.
Private temporary logs are supporting local artifacts, not the durable proof
record. OAuth URLs/codes, credentials and raw client output are excluded.

Known store limitation: a successfully exchanged grant whose later profile
publication fails can leave an unreferenced macOS Keychain item. The source
store interface has no delete operation; isolated per-attempt services prevent
changing a winner's credentials. This is not claimed to clean up orphan items.
The native-store probe explicitly removes its own successful synthetic item.

## Takeover checkpoint (2026-10-02)

Integration rebased onto main `3cb65df0c`; the refreshed source
`a9abcce8c693dae018ff73872051a9dfeabe21b6` has the same profile-login
implementation. Existing authored commits and separate corrections remain.
Final local gates after rebase: npm test 5,218 pass / zero failures / 35
platform skips, standalone typecheck and build pass. The manual server can
resume an owned fixture with `E2E_EXISTING_ROOT`, without replacing its
profile configuration.

The earlier disabled Authorize attempt is superseded: the user enabled and
clicked Authorize; the preview showed a white page / HTTP 431 at the loopback
handoff. Delivering the recovered original callback privately to that same
live backend completed exchange, changed the native grant and kept the same
profile mapping. Subsequent Mac/Linux OpenCode/SDK/model probes used that
recovered account. This establishes assisted existing-account re-authentication
while leaving automatic loopback callback proof explicitly open. No code or
credential is published. The temporary login fixture has since been removed;
the persistent owned native credential fixture supports later probes.


## Fresh-main incorporation — 2026-10-03 UTC

Recovered all four authored source commits and prior maintainer corrections
onto main `928bddc42b684680bc58f31a0aab18034197e8f3`. Current authored SHAs are
`13e8e349`, `fa431b65`, `fb6e2ae3`, `072669a9`, with original Nowaker
Author/AuthorDate preserved. The source head is still `a9abcce8`.
Documentation conflicts retained current main's flows and the browser E2E
workflow. The existing draft #1217 remains the delivery vehicle. Fresh full
local checks, affected-client verification and exact-head CI are required
before merge. The automatic browser callback has not yet been demonstrated.

## Fresh automatic callback and final-source recovery — 2026-10-04 UTC

The user completed a fresh authorization directly in the native collaborative
browser. Automatic `localhost:42215/callback` completed with HTTP 200; no
manual code transfer or callback replay was used. Native macOS Keychain access
and refresh grants both changed, expiry is future and profiles.json remains
byte-for-byte identical. No credential file appeared on macOS. The maintained
native-grant harness reproduces these assertions without printing grant values.

Two real ingress/exchange findings are corrected separately from the authored
contribution:

- The blank callback returned HTTP 431, before any OAuth handler. Actual Node
  parser failure was HPE_HEADER_OVERFLOW (16,752 received bytes). Browser
  cookie/header aggregate measurements were 16,116/16,729 bytes; HttpOnly
  localhost cookies explain why document.cookie looked empty. The real public
  Node factory now accepts a bounded 32 KiB header budget in ordinary, socket-
  activated and Antigravity ingress paths. Cookies remain untouched. The
  maintained factory harness reproduces 20 KiB cookie refusal before and
  handler reachability after; 40 KiB remains refused with 431.
- A request minted through IPv4 reached Claude with its same challenge/state
  but the consent page rewrote its redirect host from 127.0.0.1 to localhost.
  An earlier token exchange naming IPv4 returned 400; this is not described
  as an expired request. Both loopback origins and port-derived candidates
  now mint/store localhost from the start. A real corrected IPv4-started
  consent page preserves challenge, state and redirect exactly. The successful
  automatic exchange above used this exact canonical redirect spelling. The
  failing source unit control and corrected HTTP/unit exchange assertions
  preserve PKCE, port, remote paste fallback and invalid-host refusal. No
  additional real IPv4-addressed token redemption is claimed: the fixed flow
  consistently authorizes and redeems localhost.

Final client proof: macOS arm64, OpenCode 1.18.34, independently installed
scrub 0.2.3, SDK 0.2.141, packaged CLI 2.1.284 but actual PATH-selected CLI
2.1.289, native claude-opus-5-5, Bun 1.3.14. The PATH runtime changed outside
this work; no global runtime/client upgrade was performed. Both client calls
exit zero, the real read tool returns its unique receipt, and the same session
recalls it without tools. All four actual SDK queries use the intended native
credential directory and health-reported executable; all four SDK iterators
complete and public proxy close joins. Account selection and public SDK completion are observed; private SDK files
are not inspected. No kernel-wide cleanup claim is made.
The preceding post-grant run also passed on Bun 1.4.2; the final summary records
the runtime actually executed rather than inferring it from package metadata.

The live Node harness hosts the compiled createProxyServer application with the
same bounded Node ingress policy, intentionally without the separate startup
credential-refresh scheduler. The companion header harness independently
exercises startProxyServer itself. Re-authentication uses an explicitly loaded
owned profile; new-account disk discovery remains covered by the earlier Bun
live harness and real new-account proof.

The refreshed four source commits were rebuilt from their actual current
versions, including the contributor's final afterRender ordering correction,
on main e2b09669b (delivered #1253). Author and AuthorDate are unchanged:

| Source | Incorporated |
| --- | --- |
| f2b71f72a47197d1946dce400d68df87389ffbd1 | 3c682d1935880051d7f6742383b09a1f54e8bbba |
| 6d30dfac2cbff9d0684571fba5ed9c62e9bfa8bb | ed9d6e46065b934d3078ec711acdc97d1831ab24 |
| 14f2b12edebd42361d7fc9a6115f9ee402becfbf | 752deecd300785528aa1a9fc826a0d25ee42ed00 |
| a9abcce8c693dae018ff73872051a9dfeabe21b6 | e9b3251994ac37b04c2cca3fac7fa64208e847f8 |

Maintainer correction commits remain separate. The final-main rebase adds only
#1253's independent Antigravity validation/evidence; browser implementation is
byte-identical to the live-tested 9fd62b16 tree. Historical pending/assisted
notes above are superseded by these fresh automatic facts. No release is
authorized. Sanitized results are retained beside this record.

Final local gates on e2b09669b: npm test 5,273 pass / zero failures / 35
platform skips across all 17 stages (including pretest typecheck); standalone
typecheck and build pass. The current Node header harness also passes.
