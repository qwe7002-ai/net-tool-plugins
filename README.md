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
