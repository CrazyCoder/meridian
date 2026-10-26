---
id: client-integrations
type: module-design
status: active
title: Client integrations (OpenCode plugins, Pi extension)
parent: architecture
references: [api-contract]
---

## Responsibility

Code that runs **inside a client process** so Meridian receives a reliable
conversation identity and the right request shape:

- `meridian.ts` / `meridian/` — OpenCode V1 plugin: session, request and
  agent-mode headers on every Anthropic request (installed by `meridian setup`).
- `meridian-v2.ts` / `meridian-v2/` — OpenCode V2 beta plugin: detaches hidden
  title/summary one-shots from the visible conversation before they reach the
  proxy, enforcing identity again at the final HTTP boundary.
- `pi/` — Pi extension: registers a `meridian` provider from Meridian's model
  catalog and delegates streaming, tools and cancellation to Pi's built-in
  Anthropic implementation (installed by `meridian setup --client pi`).
- `priority-attestation.ts` — shared client-side signer for human-turn
  (priority failback) attestations.

## Boundary

- **Never imports server code.** Plugins depend only on their client SDK
  (`@opencode-ai/plugin`, `@earendil-works/pi-*`), Node built-ins and each
  other; everything reaches Meridian over HTTP headers.
- Header names, the attestation generations (`pi1` accepted only by the Pi
  adapter; OpenCode generations only by OpenCode) and `/health` plugin fields
  are public contract — see [`api-contract`](../.agents/references/api-contract.md).
  The server-side reading of these headers belongs to
  [`adapters`](../src/proxy/adapters/SPEC.md).
- Identity headers a client or stale configuration may have set are replaced,
  never trusted, so a request cannot bind to an unrelated conversation.
- The Pi model catalog mirrors the server's effort list (`VALID_EFFORTS`); a
  test keeps them identical.
- `plugin/` ships in the npm package; the V1/V2 plugins are bundled into
  `dist/` by `scripts/build.ts`.

Every live OpenCode test through Meridian's Claude path uses the matching
plugin generation (see `E2E.md` → *Required Meridian OpenCode plugin
preflight*).
