# Meridian Desktop — development preview

An optional Electron app for local Meridian installations. The first platform
is macOS, with native Liquid Glass through
[electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass)
on supported Macs. The distribution target is macOS Apple Silicon. Linux and Windows desktop apps
are planned; their runtime integration remains unverified.

## Downloads and updates

The first public desktop download is being prepared. The release workflow builds
signed, notarized DMG and ZIP files for [GitHub Releases](https://github.com/rynfar/meridian/releases).
See the [release guide](../../docs/desktop-releases.md) for publication status and
CI setup. The **Versions** page updates the managed Meridian service; updating
the desktop app itself currently requires downloading a newer app.

## Run locally

```sh
cd apps/desktop
npm ci
npm start
```

To build an unsigned local Mac app:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

On Apple Silicon, open `release/mac-arm64/Meridian Desktop.app`. Output
architecture follows the build machine. That command produces an unsigned
development build; it does not publish a release.
Desktop dependencies are separate: headless npm, CLI, Docker and Nix users do
not install Electron or need the app.

## Connect to an existing installation

Opening the app detects Meridian at `http://127.0.0.1:3456`. Settings accepts
another local HTTP address and an optional API key, encrypted with Electron's
secure storage. Docker works through its published local port; Nix, npm and
other supervisors expose the same Meridian HTTP interface. Remote connections
and native Docker/Nix update integrations are not implemented.

Connection alone does not grant installation or process ownership. External
services remain running when the app closes or quits. Their versions are
updated through their existing package manager. Account switches, plugin
reloads and feature changes apply to the connected service when explicitly
requested in the UI.

## App-managed installation

1. In **Versions**, check for releases and install a version for the app.
   This downloads a separate copy and leaves any external installation intact.
2. In **Service**, choose app management and an available port. To reuse an
   existing service's port, first stop that service through its current owner.
3. Start Meridian. The app verifies the version and owned listener before
   reporting success. Installed versions stay pinned until explicitly changed.

**Close window** keeps the service running in the menu bar. **Quit app** drains
and stops its owned process. Unexpected child exits trigger up to three recovery
attempts. Settings can start managed Meridian when the app opens; the packaged
Mac app can also open at login.

Version activation drains the old child, starts the selected CLI, and rolls back
the selection/process if startup fails. Installed older versions remain available
for manual rollback. The app runs the published CLI under bundled stock Node,
using normal Meridian config and Claude credential locations. It does not copy,
reset or rewrite those stores. Shell-specific environment overrides are not
imported automatically when creating a new managed installation.

On macOS, **Service → Manage this service** offers a confirmed handoff for
compatible LaunchAgents. **Return to headless** restores the original supervisor.
The handoff only considers direct, current-user, loopback CLI jobs
with a sufficiently long drain timeout and unchanged plist. Its encrypted
recovery journal is written before supervisor changes. Wrapper scripts,
containers, system services and declarative installations stay externally owned.

## Install scrub plugins

In **Plugins**, choose **Check for updates**, then **Install** or **Update** for
Pi, OpenCode, Hermes or OpenClaw. The app installs the published
`@rynfar/meridian-plugin-*-scrub` packages, preserves unrelated configuration and
plugin settings, and reloads its running service. With Meridian stopped, the
plugins load on the next start.

Plugins use the normal Meridian plugin configuration, so they remain available
when returning to a local headless installation. External Docker/Nix services
keep their own filesystem and package management; connecting does not install
packages into those environments.

## Monitoring and troubleshooting

- Live health, profiles, quota windows/reset times, request history and cache
  history; polling pauses during lifecycle operations.
- Search requests by model, account, client or ID; filter failures and low-cache
  continuations. Open a request for timing, token counts and session identifiers.
- Separate searchable views for alerts, diagnostic events and managed
  process/installer output.
- Menu-bar glass panel with service health, cache reuse, request count, first-token
  latency, account switching, quota windows and managed service controls. Right-click
  retains a native fallback menu. Disable **Open dashboard at launch** for menu-bar use.
- Desktop notifications are off by default. Enabling them selects failed automatic
  service recovery only (at most once per 15 minutes). Request failure bursts
  (three within two minutes), repeated cache misses and usage at 95% are separate
  opt-ins, limited to once per category per 30 minutes and one advisory per five
  minutes overall. Cooldowns persist across restarts. Pause notifications for one
  hour in Settings or the panel; paused alerts are not replayed. In-app history
  remains available regardless of notification settings. Initial request and quota
  history seeds silently; raw error details never appear in desktop notifications.
- Profile sign-in through the selected managed CLI, account switching, plugin
  reload, and client feature toggles.
- Export an operational summary with aggregate timings and counts, excluding
  raw logs and prompts.

Summary metrics use the server's reported time window. Request history can
include older requests. Missing quota data is not zero usage. Cache alerts are
advisory: three recent continuations are grouped by account, model and client
source, not proof of a cache bug in one SDK session.

App preferences, encrypted connection credentials, installed versions and
bounded incident history live under Electron's user-data directory in the
`preview` subdirectory (retained for compatibility with the first preview).
Service output is bounded in memory. Secrets, request histories and raw logs
are not included in the diagnostic export.

## Verification status

Focused tests exercise real Node child startup, request draining, occupied-port
refusal, failed-version rollback and crash recovery. The actual unsigned Mac app
has installed published releases and switched its owned service between 1.71.1
and 1.71.0 while leaving the external service on 3456 untouched.

On September 18, the signed Mac app completed Claude sign-in, displayed real
usage limits, and delivered its native notification test successfully. Live
Haiku requests succeeded before and after a UI restart. A disposable real
LaunchAgent passed takeover, all four registry plugin installations/reloads,
return to its original supervisor with plugins retained, and recovery of an
interrupted return. See [`E2E.md`](../../E2E.md#desktop-interface-preview).

The final arm64 build was signed with Developer ID, accepted by Apple
notarization, stapled, and accepted by Gatekeeper on September 18. Its actual UI
confirmed takeover and return of a disposable LaunchAgent; a real Haiku
conversation continued after returning to headless, and a plugin installed
through the app remained active. No Meridian release was published.

Windows and Linux runtime verification remains outstanding. This is a macOS
preview, not a claim of production support on all three platforms.
