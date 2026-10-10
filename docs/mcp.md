# MCP adapter

TLH ships a scoped package of `pi-mcp-adapter` as the non-critical bundled default `mcporter`. It is pinned to `npm:@diegopetrucci/pi-mcp-adapter@2.36.0`, preserving the TLH MCP status-bar footer behavior: it uses the dim style (matching the other footer lines) and lists actively-connected server names after the count when one or more servers are connected (e.g. `MCP: 1/1 servers, atlassian`). This pin also picks up the adapter's lazy-loading startup facade so TLH avoids paying the full MCP adapter import cost until MCP work is actually needed.

When the MCP status line is visible, TLH appends an approximate retained-context estimate such as `MCP: 1/1 servers, atlassian • (3.2% of context)`. The estimate includes active MCP tool definitions plus retained MCP tool calls and results in the current context. It is a local display aid, not a provider billing value, and may change after messages, tool results, branch changes, compaction, or MCP activation change what remains in context.

## Default usage

TLH uses the adapter in a proxy-first way: by default you get one `mcp` tool that routes requests to your configured MCP servers, instead of exposing every MCP tool directly. All four packaged primary agents and all nine packaged minor agents declare this generic gateway while preserving their other tools.

- Primary agents and `developer` may call the gateway within their authorized task scope and existing role boundaries.
- Read-only minors are instructed to avoid mutations and escalate uncertain side effects. This is prompt guidance, not gateway enforcement; the gateway itself may still expose a tool with side effects.
- The packaged `test-runner` is the intentional unrestricted exception: it may use assigned generic MCP steps to discover, connect to, and invoke any configured server/tool, including tools that change server-side state. Its exact validation-ticket and repository/ticket restrictions still apply.

Direct `mcp:*` child tools remain filtered out, and `MCP_DIRECT_TOOLS=__none__` prevents an unset direct-tool setting from bootstrapping configured direct tools.

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

> **Note (Pi 1.0.1+):** Pi 1.0.1 documents per-server `enabled`, `exposure`, and `toolExposure` overrides for `.pi/mcp.json`. These fields are read by Pi's built-in `mcp` extension — which TLH disables while `mcporter` owns `/mcp`. The `mcporter` adapter honours `"disabled": true` to disable a server; it does **not** honour `"enabled": false`. Setting `"enabled": false` will not disable a server under TLH. Use `"disabled": true` instead.

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

## Built-in MCP compatibility

Pi 1.0.0 and later include a built-in `mcp` extension (`builtin:mcp`) that also registers the `/mcp` command. TLH's packaged settings defaults persist `-builtin:mcp` in the isolated profile before the bundled `mcporter` adapter loads. This keeps the adapter as the sole `/mcp` owner and prevents Pi's built-in-extension replacement warning; the warning should not appear in a normal TLH session.

This is temporary compatibility behavior while `mcporter` owns `/mcp`. Install/update adds the exclusion only when `mcporter` is present and enabled in the bundled default-extension manifest. When TLH inserts it, the isolated settings record `tlh.builtinMcpExclusionManaged: true` as ownership evidence. A pre-existing exclusion without that marker is user-owned: TLH preserves it during opt-out and does not claim it when the adapter is enabled. Disabling `mcporter`, opting it out by package filter, or removing it from the manifest removes only a TLH-managed exclusion and clears the marker; unrelated extension settings remain unchanged.

Keep the adapter enabled — it is the intended TLH MCP integration. To switch to native MCP, run `tlh defaults disable mcporter`; Pi's built-in `builtin:mcp` will load on next session start without a warning only if no `-builtin:mcp` exclusion remains in the isolated settings. TLH removes only a TLH-managed exclusion; a preserved user-owned exclusion continues to prevent native MCP from loading. If TLH migrates away from `mcporter`, that migration must explicitly remove any TLH-managed `-builtin:mcp` entry and its ownership marker while preserving unmarked user exclusions. Tracking upstream `builtin:mcp` progress is recorded in [#705](https://github.com/diegopetrucci/the-last-harness/issues/705), but that native migration is a non-goal of the per-agent gateway contract.

If `mcporter` is disabled and native `builtin:mcp` loads, this provides core MCP connectivity without TLH's adapter-specific features (status-bar footer, proxy `mcp` tool). In particular, the packaged agents' generic proxy-gateway contract is lost while the adapter is disabled; enabling the native extension does not recreate that contract. Direct `mcp:*` child tools remain filtered out.

## Rollback and re-enable

To undo an adapter opt-out and restore the packaged generic `mcp` gateway, re-enable the bundled adapter and restart or reload TLH:

```sh
tlh defaults enable mcporter
```

This restores the adapter-specific proxy gateway and footer behavior; it does not migrate the profile to native MCP or change the child direct-tool safety sentinel.

## Opt out

If you do not want TLH to manage the bundled adapter for that isolated profile:

```sh
tlh defaults disable mcporter   # opt out; reload uses native MCP without TLH's proxy gateway
tlh defaults enable mcporter    # re-enable the TLH gateway
```
