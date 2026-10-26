---
id: plugins
type: module-design
status: active
title: User plugins
parent: architecture
depends-on: [adapters, telemetry-ui]
references: [api-contract]
---

## Responsibility

Let operators customize Claude request behavior and observe session decisions
**without changing core code**: discover, validate, load and reload user
`Transform` plugins, keep per-plugin stats, and render the read-only `/plugins`
page.

Motivation: feature toggles proposed for single clients (e.g. moving the system
prompt into the first user message) kept growing `server.ts`; such
customizations belong in user space, outside the release cycle.

Code: `src/proxy/plugins/`. The `Transform` interface and pipeline runner live
in `transform.ts`, owned by [`adapters`](../adapters/SPEC.md).

## Boundary

- **Pipeline order:** the adapter's built-in transforms first, then plugins in
  `plugins.json` order. Plugins declare no priority numbers; the user owns order.
- **Scoping:** `adapters: [...]` limits a plugin to named adapters (omitted =
  all); unknown names warn, duplicate plugin names are skipped.
- **Failure isolation:** a hook returns a new context; a throwing hook is
  logged and the previous context continues — a plugin never crashes the proxy.
- **Discovery:** files in the config `plugins/` directory plus absolute paths
  in `plugins.json`; unlisted files are appended and enabled; both resolve
  through the relocatable config path. `POST /plugins/reload` reloads.
- **Resume correctness stays in core:** `onSession` runs after lineage
  classification and its return value is ignored. Plugin changes to messages
  affect SDK execution but never the lineage proof (see
  [`session`](../session/SPEC.md)).
- **Claude path only.** ChatGPT requests never enter plugin hooks, and
  Antigravity has its own separate plugin/observer interface.
- The `Transform` type and plugin configuration are public contract
  ([`api-contract`](../../../.agents/references/api-contract.md)).

Author guide: `PLUGINS.md`; official packages: `docs/plugins.md`.

## Known limitations

- **Response hooks are not wired.** `onResponse` and `onTelemetry` types exist,
  but the Claude HTTP path does not call them; `onToolUse`, `onToolResult` and
  `onError` are reserved.
- **The `/plugins` UI is read-only** (list + reload); enabling, disabling and
  reordering require editing `plugins.json`.
- Under Node (npm installs) plugins must be compiled `.js`; `.ts` works only
  when Meridian runs under Bun.
