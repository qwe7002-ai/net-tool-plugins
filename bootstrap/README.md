# Plugin bootstrap

`bootstrap.mjs` is the launcher that turns a plugin checkout into a running MCP
server without a Go or Bun toolchain on the user's machine. It resolves the
host platform, downloads the matching prebuilt binary from this repository's
releases, verifies its SHA-256 against the release's `manifest.json`, caches it,
and execs it with whatever arguments the plugin's `.mcp.json` passes through.

The binaries come from [`.github/workflows/build-binaries.yml`](../.github/workflows/build-binaries.yml),
which cross-compiles every plugin in [`marketplace.json`](../.agents/plugins/marketplace.json)
from its pinned upstream ref.

## Vendoring it into a plugin

The file is identical in every plugin — it identifies itself by reading the
sibling `.codex-plugin/plugin.json`, so there is nothing to edit. Copy it in as
`scripts/bootstrap.mjs` and repoint `.mcp.json`:

```bash
curl -fsSL -o scripts/bootstrap.mjs \
  https://raw.githubusercontent.com/qwe7002-ai/net-tool-plugins/main/bootstrap/bootstrap.mjs
```

Two things `.mcp.json` must do:

- **`cwd` must be `${PLUGIN_ROOT}`**, because `args` names the script by a
  relative path.
- **`env.MCP_PLUGIN_DATA` must be `${PLUGIN_DATA}`.** Codex substitutes
  `${PLUGIN_DATA}` in the config but does not export it to the server process;
  passing it explicitly is what puts the binary cache in the plugin's own data
  directory instead of a shared `~/.cache/net-tool-plugins`.

Raise `startup_timeout_sec` to something like `180`: the first start of a given
release downloads the binary, and the compiled Bun servers are large.

### `ssh-mcp`

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["scripts/bootstrap.mjs", "serve"],
      "cwd": "${PLUGIN_ROOT}",
      "env": {
        "MCP_PLUGIN_DATA": "${PLUGIN_DATA}",
        "SSH_MCP_KEY_DIR": "${PLUGIN_DATA}/keys"
      },
      "startup_timeout_sec": 180
    }
  }
}
```

### `mikrotik-mcp`

```json
{
  "mcpServers": {
    "mikrotik-mcp": {
      "command": "node",
      "args": ["scripts/bootstrap.mjs", "serve"],
      "cwd": "${PLUGIN_ROOT}",
      "env": { "MCP_PLUGIN_DATA": "${PLUGIN_DATA}" },
      "startup_timeout_sec": 180,
      "tool_timeout_sec": 60
    }
  }
}
```

### `tplink-easy-smart-switch-mcp`

The compiled Bun binary takes no subcommand.

```json
{
  "mcpServers": {
    "tplink-easy-smart-switch-mcp": {
      "command": "node",
      "args": ["scripts/bootstrap.mjs"],
      "cwd": "${PLUGIN_ROOT}",
      "env": { "MCP_PLUGIN_DATA": "${PLUGIN_DATA}" },
      "startup_timeout_sec": 180,
      "tool_timeout_sec": 60
    }
  }
}
```

## Behaviour worth knowing

- **Everything it prints goes to stderr.** stdout belongs to the MCP stdio
  transport.
- **Nothing is executed unverified.** The cache path carries the digest
  (`<data>/bin/<sha256[0:12]>/<asset>`) so different builds cannot collide, but
  the path is a label rather than a proof: every cache hit is hashed and
  compared with `manifest.json` before the binary is run, and an entry that does
  not match is discarded and re-downloaded.
- **Concurrent first starts are safe.** Two servers starting cold race to
  publish the same cache entry; the loser verifies the winner's copy and uses it
  instead of failing.
- **The release manifest is cached for six hours** when tracking `latest`, so a
  normal server start does no network I/O at all. A pinned tag is immutable and
  its manifest never expires.
- **Offline starts degrade instead of failing**: if the manifest cannot be
  refreshed but a previous copy exists, the stale one is used.

## Environment variables

| Variable | Effect |
| --- | --- |
| `<PLUGIN_NAME>_BINARY` (e.g. `SSH_MCP_BINARY`) | Run this executable and skip the download entirely. Use it for local development, or on a platform no binary is built for. |
| `MCP_PLUGIN_DATA` | Where to cache binaries. Defaults to `~/.cache/net-tool-plugins`. |
| `NET_TOOL_PLUGINS_RELEASE` | Pin to a release tag instead of tracking `latest`. |
| `NET_TOOL_PLUGINS_REPO` | Repository to fetch releases from. Defaults to `qwe7002-ai/net-tool-plugins`. |
| `NET_TOOL_PLUGINS_DOWNLOAD_BASE` | Serve assets from a mirror instead of the release's download URL. |
| `NET_TOOL_PLUGINS_MANIFEST_TTL_SECONDS` | How long a `latest` manifest stays fresh. Defaults to `21600`. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Used for the release lookup when set, which raises the anonymous API rate limit. |

## Tests

```bash
node bootstrap/test/bootstrap.test.mjs
```

Covers the download, checksum verification, caching, the override, and the
failure messages, against a local HTTP server — no network access needed.
