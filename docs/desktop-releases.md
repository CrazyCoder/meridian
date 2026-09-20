# Desktop releases

[← Back to README](../README.md)

Desktop distribution starts with macOS Apple Silicon. Linux and Windows desktop
releases are planned. The headless npm package and Docker images keep their
existing release paths and do not depend on Electron.

## Pipeline

The normal Release Please workflow calls `desktop-release.yml` directly when it
creates a release. A separate tag-triggered workflow would not run for tags
created with GitHub’s default workflow token.

1. Check the release tag resolves to the exact source commit.
2. Install the locked desktop dependencies on a macOS ARM runner.
3. Build the app with the root release version embedded in its metadata.
4. Sign with Developer ID and notarize with Apple through electron-builder.
5. Verify the signature, stapled ticket and Gatekeeper acceptance. Check the ZIP’s
   extracted app too.
6. Save the DMG, ZIP, SHA-256 checksums and source/workflow record as Actions artifacts.
7. Attach those files to the matching GitHub release.

Missing credentials, signing or notarization failures stop publication. Existing
release assets are not silently overwritten. npm and Docker publish independently;
check all release jobs before announcing a release as complete.

Before merge, manually run **Release Please** on the candidate branch with
**desktop_rehearsal** checked and **publish_only** unchecked. This creates signed
Actions artifacts without opening a release PR or publishing packages.

After merge, manually run **Desktop release** on `main` with
**publish** unchecked. The verified downloads are retained as Actions artifacts
without changing a public release. Publishing requires the current commit to be
the existing release tag’s exact target.

## Repository secrets

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate and private key |
| `CSC_KEY_PASSWORD` | Certificate export password |
| `APPLE_API_KEY` | App Store Connect `.p8` key contents |
| `APPLE_API_KEY_ID` | That key’s ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |

The workflow writes the notarization key to a permission-restricted temporary file
and removes it even if packaging fails. Publication runs only from `main`. A maintainer can explicitly run a
non-publishing candidate rehearsal; pull requests never receive signing credentials. Keep these credentials out of source control and workflow logs.

## User updates

The desktop app’s **Versions** page updates the Meridian service it owns. Updating
the desktop app itself currently means downloading a newer app from GitHub
Releases. Background desktop self-update is not implemented. External Docker,
Nix and other supervised installations keep their existing update mechanism.

The desktop build takes its displayed version from the root release without
changing the independently installed service version. The development package’s
version is only a local placeholder.

## References

- [electron-builder signing](https://www.electron.build/docs/features/code-signing/)
- [electron-builder notarization](https://www.electron.build/v26/docs/notarization/)
- [GitHub runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
