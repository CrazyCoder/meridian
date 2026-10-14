# Release 1.82.0 (2026-10-14)

Owner-authorized release through Release Please PR #1345.

| | |
|---|---|
| Candidate (release PR head) | `9494462a761c6fa1f096716b1f68222926b95c95`, on `main` `74ee96752` |
| Release PR diff | version in `package.json`, `package-lock.json`, `.release-please-manifest.json`; `CHANGELOG.md` section (since `meridian-v1.81.0`) |
| Merge | `e689a0d674cca6a7a9effd6a8e728cc25941b32d` (`--merge --match-head-commit`) |
| Tag / GitHub release | `meridian-v1.82.0`, published 2026-10-14T13:33:44Z, target `e689a0d67` |
| Release Please run | https://github.com/rynfar/meridian/actions/runs/38572774080 (release-please, publish, docker, desktop / mac: success) |
| npm | `@rynfar/meridian@1.82.0`, `latest`, `gitHead` `e689a0d67`, integrity `sha512-P7ctWnMpMpjrzqaiTeMNNZdJhkfWyG4DDi5rHc50BSnYO49O14HgunnpUDY9dcVeehbgDke74vEWynzoAgvAbA==`, provenance attestation published (sigstore log index 3250722971) |
| Docker | `ghcr.io/rynfar/meridian:1.82.0`, linux/amd64 and linux/arm64 |

## Gates on the candidate

- Local, Bun 1.3.14, macOS arm64: `npm test` (typecheck, then the full suite)
  6,088 pass, 0 fail, 35 skipped; `npm run build` certified.
- CI on the exact candidate: all checks passed. The release PR's workflow runs
  were waiting for approval (bot-authored PR) and were approved by the
  maintainer before they ran.
- Installed package: `npm pack` of the candidate installed into an isolated
  prefix, run on its own port with isolated config and session directories.
  Real Claude Code 2.1.299, model `sonnet`: a two-turn conversation where turn 1
  ran a Bash tool (`echo release-1`) and turn 2 resumed (`lineage=continuation`);
  `/health` reported 1.82.0 and `upstream.claude` `ok` with a recorded answer.

## After publication

- npm served 1.82.0 about two and a half minutes after the publish step
  reported success (an immediate `npm view` returned 404 while the registry
  processed it).
- Fresh registry install into an isolated prefix: the same two-turn Claude Code
  conversation passed (tool ran, turn 2 resumed), `/health` 1.82.0.

## Seen during validation

Claude Code 2.1.299 prints, for sessions through any local gateway: "We're
changing auto mode to no longer charge for classifier requests in Claude Code.
However, this session isn't eligible because your requests go through
127.0.0.1:…", pointing at
https://code.claude.com/docs/en/auto-mode-classifier-billing. Auto mode keeps
working; supporting the new classifier billing would be a separate change.

Not covered: Linux and Windows installed-package runs, OpenCode and Pi clients
against the published package, the desktop app.
