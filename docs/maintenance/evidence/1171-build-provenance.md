# Local build provenance incorporation (#1171)

Source head `8b6e2ff482f756b80d5ed5db9ed1869ca892e87f`, issue #1170.
The user's selected Nowaker scope supplies approval. Four authored cherries
preserve Author/AuthorDate: `483ab8f2 -> c1cf603f`, `1e916f00 -> 2710e95b`,
`f3fc5c10 -> d955d463`, `8b6e2ff4 -> 35946ddd`. Base `e3fa58208`.
Maintainer corrections are separate; the user's dirty checkout is untouched.

Product fit: local/dev operators can distinguish immutable running identity
from changed source or newer disk artifacts. Certified counters count successful
builds in one worktree, never commits. An embedded attempt must match the ledger,
manifest and complete artifact inventory. npm installs retain their existing
update behavior and do not poll local build status. Public scope is tracked in
#1170; no release or private-fork deployment is performed.

## Material adversarial findings

- macOS `/var` versus `/private/var` aliases of the same repository were refused
  by lexical root comparisons. The authored focused suite had 19 failures;
  normal source/certification fixtures lost provenance. Canonical root equality
  corrects that while still refusing nested-directory parent adoption.
- Source/artifact verification used whole-file reads without resource bounds.
  A normal untracked large file could allocate arbitrary memory during startup.
  Streaming 64 KiB reads now enforce 64 MiB/file, 256 MiB total, 10,000 entries,
  two-second scan deadlines, 2 MiB Git output and artifact depth 32. JSON metadata
  is capped before allocation/parsing. Exceeding a bound never certifies a prefix.
- The authored E2E harness repurposed HOME. It now uses explicit isolated
  Meridian/session/Claude directories and an empty profile, with host credentials
  and running services untouched.

Retained `build-fingerprint-budget.test.ts` controls fail 0 pass / 3 fail on
unchanged authored code (`35946ddd`) and pass with the correction. The initial
noncanonical negative fixture was corrected before trusting its result: the
alias defect had rejected it before hashing, masking the source-size defect.
The final four-file focused set has 36 pass, zero failures, and includes a
metadata allocation cap plus UTF-8 control. Parent adoption remains refused.
Pure comparisons/badge logic remain separate from Git/filesystem boundaries;
worker scans remain single-flight and off the HTTP streaming event loop.

## Actual and synthetic flow evidence

macOS arm64, Node 22.22.3, Bun 1.3.11: final `npm test` 5,071 pass, zero
failures, four platform skips; standalone typecheck/build pass. The maintained
`node scripts/e2e-build-provenance.mjs` passes against the actual bundled Node
HTTP server twice. Final runtime build 5 stays immutable while three successful
rebuilds advance disk to 8 and report exactly three builds behind. Thirty
concurrent cached status requests return 200. No model calls are needed for
this build/status flow and no host/default credentials are adopted.

The collaborative preview executes the actual shared header through maintained
`scripts/e2e-build-header-fixture.ts` with synthetic API responses. Eight states
pass: current, three builds behind, rollback, source changed, invalid, unknown,
failed status request, and npm. Health remains Operational through drift/status
failure, safe branch/commit links use HTTPS and noopener/noreferrer, repeated
polls preserve the same focused link node, and npm makes zero status requests.
No horizontal overflow at the measured 1169px CSS viewport. A saved synthetic
screenshot was visually inspected and contains no secrets. Resize repeatedly
timed out; independent 375/768px or interactive Windows verification is not
claimed. The contributor's wider visual QA is background evidence, not our run.

Required exact-head CI, including Windows smoke and full test, remains a merge
gate. Earlier contributor/private-fork checks do not certify this integration.
Runnable harnesses and this record are durable; temporary raw logs/screenshots
are supporting local artifacts. No credential, authorization code or customer
transcript is included.
