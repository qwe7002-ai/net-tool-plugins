# net-tool-plugins

A Codex plugin marketplace for networking and remote-system tools.

## Install

```bash
codex plugin marketplace add qwe7002-ai/net-tool-plugins --ref main
codex plugin add ssh-mcp@net-tool-plugins
codex plugin add mikrotik-mcp@net-tool-plugins
codex plugin add tplink-easy-smart-switch-mcp@net-tool-plugins
```

Start a new Codex task after installing a plugin so its skills and MCP tools are
loaded.

## Available plugins

- [`ssh-mcp`](https://github.com/qwe7002-ai/ssh-mcp) — SSH command execution,
  SFTP file operations, and managed SSH key installation.
- [`mikrotik-mcp`](https://github.com/qwe7002-ai/mikrotik-mcp) — Safe MikroTik
  RouterOS inspection and configuration through a local MCP server.
- [`tplink-easy-smart-switch-mcp`](https://github.com/qwe7002-ai/tplink-easy-smart-switch-mcp)
  — TP-Link and Mercury Easy Smart switch inspection, topology analysis, and
  guarded VLAN or trunk configuration.

## Prebuilt binaries

Installing a plugin does not require a Go or Bun toolchain. This repository
builds every plugin's MCP server centrally and publishes the binaries as its own
releases; each plugin ships a launcher that downloads the one matching the host.

- [`.github/workflows/build-binaries.yml`](.github/workflows/build-binaries.yml)
  resolves each plugin's ref from [`marketplace.json`](.agents/plugins/marketplace.json)
  to a commit, cross-compiles it for five platforms, and publishes the binaries
  together with `SHA256SUMS` and a `manifest.json`.
- [`bootstrap/bootstrap.mjs`](bootstrap/bootstrap.mjs) is the launcher, vendored
  into each plugin as `scripts/bootstrap.mjs`. On server start it picks the asset
  for `<process.platform>-<process.arch>`, verifies its SHA-256 against
  `manifest.json`, caches it under the plugin's data directory, and execs it.
  See [`bootstrap/README.md`](bootstrap/README.md) for the `.mcp.json` snippets
  and the environment variables it honours.

Built platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
`win32-x64`. On anything else, build the server yourself and point the plugin's
`<PLUGIN_NAME>_BINARY` variable at it (for example `SSH_MCP_BINARY`).

The build recipes live in [`.github/plugins-build.json`](.github/plugins-build.json);
`marketplace.json` stays the single source of truth for upstream URLs and refs,
and CI fails if the two disagree about which plugins exist.

### Rebuilding

The workflow runs on `workflow_dispatch` (optionally with an explicit tag), on
pushes to `main` that touch the marketplace manifest, the build recipes, the
workflow, or the bootstrap, and weekly — the pinned refs are branches, so a
scheduled rebuild keeps the published binaries close to their heads.

## Development

```bash
node bootstrap/test/bootstrap.test.mjs
```
