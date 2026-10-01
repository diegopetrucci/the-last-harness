# MCP adapter

TLH ships a scoped package of `pi-mcp-adapter` as the non-critical bundled default `mcporter`. It is pinned to `npm:@diegopetrucci/pi-mcp-adapter@2.36.0`, preserving the TLH MCP status-bar footer behavior: it uses the dim style (matching the other footer lines) and lists actively-connected server names after the count when one or more servers are connected (e.g. `MCP: 1/1 servers, atlassian`). This pin also picks up the adapter's lazy-loading startup facade so TLH avoids paying the full MCP adapter import cost until MCP work is actually needed.

When the MCP status line is visible, TLH appends an approximate retained-context estimate such as `MCP: 1/1 servers, atlassian • (3.2% of context)`. The estimate includes active MCP tool definitions plus retained MCP tool calls and results in the current context. It is a local display aid, not a provider billing value, and may change after messages, tool results, branch changes, compaction, or MCP activation change what remains in context.

## Default usage

TLH uses the adapter in a proxy-first way: by default you get one `mcp` tool that routes requests to your configured MCP servers, instead of exposing every MCP tool directly. The packaged `test-runner` receives this generic `mcp` gateway alongside `bash`, so an assigned final-validation step can discover, connect to, and invoke any configured server/tool, including tools that change server-side state. The runner still may not edit the repository, install or fix anything, mutate tickets, delegate, or use direct `mcp:*` child tools. Its `MCP_DIRECT_TOOLS=__none__` sentinel prevents an unset direct-tool setting from bootstrapping configured direct tools.

Common slash commands:

- `/mcp` — show adapter status.
- `/mcp setup` — walk through MCP setup.
- `/mcp tools` — list available MCP tools.
- `/mcp reconnect` — reconnect all configured servers.
- `/mcp reconnect <server>` — reconnect one server.
- `/mcp-auth <server>` — complete OAuth login for one server.

## Configuration

- Bundled default id: `mcporter`
- Extension source: `npm:@diegopetrucci/pi-mcp-adapter@2.36.0`
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

## Startup warning

Pi 0.99.0 introduced a built-in `mcp` extension (`builtin:mcp`) that also registers the `/mcp` command. When TLH's `mcporter` adapter loads and registers `/mcp`, Pi detects the conflict, leaves the built-in MCP out, and emits a resource-loader warning that looks like:

```
Extension <mcporter-install-path> registers command `/mcp`, so built-in extension `mcp` was not loaded. To use `mcp`, run `pi config` and make sure it is enabled under Built-in extensions, then disable or remove the existing extension. We recommend only having one or the other loaded at a time.
```

The `pi config` advice is Pi's generic text for any built-in replacement. In TLH, **keep the adapter enabled** — it is the intended MCP integration. The adapter replaces the built-in intentionally. To switch to native MCP instead, run `tlh defaults disable mcporter` and reload; the built-in will then load without a warning. Tracking upstream `builtin:mcp` progress is recorded in [#705](https://github.com/diegopetrucci/the-last-harness/issues/705).

If `mcporter` is disabled, Pi's native `builtin:mcp` loads instead. This provides core MCP connectivity without TLH's adapter-specific features (status-bar footer, proxy `mcp` tool).

## Opt out

If you do not want TLH to manage the bundled adapter for that isolated profile:

```sh
tlh defaults disable mcporter   # opt out
tlh defaults enable mcporter    # re-enable
```
