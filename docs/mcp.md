# MCP adapter

TLH ships a scoped package of `pi-mcp-adapter` as the non-critical bundled default `mcporter`. It is pinned to `npm:@diegopetrucci/pi-mcp-adapter@2.10.2`, preserving the TLH MCP status-bar footer behavior: it uses the dim style (matching the other footer lines) and lists actively-connected server names after the count when one or more servers are connected (e.g. `MCP: 1/1 servers, atlassian`). This pin also picks up the adapter's lazy-loading startup facade so TLH avoids paying the full MCP adapter import cost until MCP work is actually needed.

## Default usage

TLH uses the adapter in a proxy-first way: by default you get one `mcp` tool that routes requests to your configured MCP servers, instead of exposing every MCP tool directly.

Common slash commands:

- `/mcp` — show adapter status.
- `/mcp setup` — walk through MCP setup.
- `/mcp tools` — list available MCP tools.
- `/mcp reconnect` — reconnect all configured servers.
- `/mcp reconnect <server>` — reconnect one server.
- `/mcp-auth <server>` — complete OAuth login for one server.

## Configuration

- Bundled default id: `mcporter`
- Extension source: `npm:@diegopetrucci/pi-mcp-adapter@2.10.2`
- Supported MCP config locations:
  - Shared config: `~/.config/mcp/mcp.json`
  - TLH isolated profile: `~/.the-last-harness/agent/mcp.json` or `${PI_CODING_AGENT_DIR}/mcp.json`
  - Project config: `.mcp.json`
  - Project-local Pi config: `.pi/mcp.json`

Use the isolated-profile or project-local files when you want TLH-specific or repo-specific MCP server definitions without changing shared machine-wide config.

The adapter expects a top-level `mcpServers` object. Minimal examples:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "example-remote": {
      "url": "https://example.com/mcp",
      "auth": "oauth"
    }
  }
}
```

For stdio servers, use `command` plus `args`. For HTTP servers, use `url`; add `auth: "oauth"` when the server uses OAuth, then run `/mcp-auth <server>` to finish login. Upstream also supports `${VAR}` and `$env:VAR` interpolation in fields such as `env`, `headers`, `cwd`, and `bearerToken`.

## OAuth and direct tools

For OAuth-backed servers, configure an HTTP `url` for the server and then run `/mcp-auth <server>` to finish login.

`directTools` is opt-in. It exposes individual MCP tools directly instead of going through the proxy `mcp` tool, but it is more token-expensive and may need cache warm-up or a manual `/mcp reconnect <server>` before the direct tool list is ready.

## Opt out

If you do not want TLH to manage the bundled adapter for that isolated profile:

```sh
tlh defaults disable mcporter   # opt out
tlh defaults enable mcporter    # re-enable
```
