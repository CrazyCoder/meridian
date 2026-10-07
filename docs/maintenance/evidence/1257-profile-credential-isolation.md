# Profile credential metadata isolation (#1257)

Accept an internal context-isolation correction, preserving the existing
GET /health and GET /profiles/list response fields. Explicit API-key and
supplied setup-token profiles do not authenticate with a stored OAuth grant;
they must not inherit that store's plan/renewal facts or empty-token demotion.
Stored claude-max profiles retain their own metadata and presence protections.

Unchanged main's exact tree (integration head
cc8b0634cf2369ee4c2e07b54b36065fd1996be8, delivered as 240287e809cb57f675e7919de76f6d867a3d3352)
reproduces four HTTP regression failures: unrelated Max 20x metadata, API
logged-out demotion, setup-token demotion and unnecessary native-store reads.
The corrected product commit 68a614ecd68a02467d693de39b4838dbba746447 passes
all eight HTTP controls. Specific negatives preserve resolved-directory and
default-store subscription metadata/renewal, actual empty-grant demotion,
unknown/unavailable-store auth status, and logged-out API status.

The maintained scripts/e2e-profile-credential-isolation.mjs runs actual HTTP,
actual Claude Code 2.1.289 auth status and actual owned macOS Keychain writes /
reads. The default-store factory is redirected to a unique owned synthetic
item before HTTP reads: no host default credential is read or modified. On
Bun 1.3.14 / macOS arm64 the before control makes six fallback selections and
eight native reads, inherits Max 20x/renewal, and demotes the API profile when
the unrelated grant is empty. Corrected source makes zero selections/reads;
both cases remain healthy/authenticated with null allowance/tier and no renewal
warning. The synthetic key is recognized by the real CLI; this is not proof
that it works for inference. SDK query is fenced and no model calls occur.
Native item and owned directory cleanup succeed in finally.

Repeat the source control with E2E_SOURCE_ROOT pointing at unchanged source,
E2E_SOURCE_SHA checking its exact head, and E2E_EXPECT_METADATA_LEAK=1. Omit
expected-leak for correction acceptance. E2E_SERVE_PORT serves the same owned
app for browser inspection until SIGINT/SIGTERM; model routes are refused.
The native Pylon Chrome 152 / Electron 44 Profiles page independently renders
Max 20x + Not logged in before, and Authenticated with no unrelated plan after.
Only synthetic profile metadata is shown. Snapshot capture failed twice, so
no new screenshot is claimed. Sanitized native results are committed beside
this record. No Linux/Windows native proof or real-account inference claim.

Adversarial review: an undefined store cannot be passed to the metadata helpers
for a non-stored profile, because those helpers silently select the default
store. Both routes therefore gate construction and each read. Unknown native
credentials are not treated as absent. The API key is still judged by its own
auth-status result; this fix does not manufacture logged-in status. The implicit
default Claude subscription remains unchanged. No public fields, routes,
settings, session behavior, SDK persistence, or dependencies are added.
Process-global auth/store spies are isolated in their own npm-test stage.

Final local gates pass: npm test 5,304 / 0 / 35 platform skips across 18
isolated stages (including its pretest typecheck), standalone typecheck and
build. [Integration #1258](https://github.com/rynfar/meridian/pull/1258) carries
final-head CI and delivery state; required CI remains a merge gate. This correction does not close the held cache/SQLite stack.
