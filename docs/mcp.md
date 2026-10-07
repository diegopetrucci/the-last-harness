# MCP adapter

TLH ships a scoped package of `pi-mcp-adapter` as the non-critical bundled default `mcporter`, pinned to the published `npm:@diegopetrucci/pi-mcp-adapter@5.0.0`. The adapter provides TLH's proxy-first MCP gateway and lazy-loading startup behavior without making MCP a critical part of the profile.

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
- Extension source: `npm:@diegopetrucci/pi-mcp-adapter@5.0.0`
- Shared server config: `~/.config/mcp/mcp.json`
- TLH/Pi native config: `${PI_CODING_AGENT_DIR}/mcp.json` (by default `~/.the-last-harness/agent/mcp.json`)
- Project shared config: `.mcp.json`
- Project Pi native config: `.pi/mcp.json`
- Global adapter-owned config: `${PI_CODING_AGENT_DIR}/mcp-adapter.json`
- Project adapter-owned config: `.pi/mcp-adapter.json`

Use the shared `mcp.json` files for server definitions. Use `mcp-adapter.json` for adapter-owned `settings`, imports, and overrides; do not put those adapter-specific options in a native Pi `mcp.json`.

### Configuration precedence and native translation

For the normal TLH profile, these sources are applied in order. Most layers merge same-named server entries field by field, so partial adapter overrides retain unset definition fields rather than replacing the complete server definition. Explicit transport overrides (`command`, `url`, or `socket`) discard incompatible fields from the other transport; when a changed `url` is applied, inherited URL-bound authentication material (`headers`, `bearerToken`, `bearerTokenEnv`, `bearerTokenStore`, `requestHeadersCommand`, `caFile`, object-valued `auth`, and non-`false` `oauth`) is cleared, while authentication explicitly supplied by the higher-precedence definition remains. The native project `.pi/mcp.json` entry replaces a matching native `${PI_CODING_AGENT_DIR}/mcp.json` entry before the project adapter override is applied:

1. `~/.config/mcp/mcp.json`
2. `${PI_CODING_AGENT_DIR}/mcp.json`
3. `${PI_CODING_AGENT_DIR}/mcp-adapter.json`
4. opted-in ancestor `.mcp.json` and `.pi/mcp-adapter.json` files, farthest first
5. `.mcp.json`
6. `.pi/mcp.json`
7. `.pi/mcp-adapter.json`

Ancestor discovery is opt-in through `settings.ancestorConfigRoots` in a user-global or explicitly selected adapter config. Within a directory, adapter-owned config overrides shared config; project files override global files.

On Pi 0.99 and later, `mcporter` reads the native `${PI_CODING_AGENT_DIR}/mcp.json` and `.pi/mcp.json` server entries and translates supported Pi fields. In native `mcp.json`, `enabled: false` is translated to the adapter's `disabled: true`; native `exposure` and `toolExposure` are also translated to the corresponding adapter controls. By contrast, `disabled: true` is the adapter-owned setting for shared `mcp.json` and `mcp-adapter.json` configuration.

Existing adapter-specific fields in a native `mcp.json` are ignored rather than migrated. Explicitly relocate or merge those fields into the corresponding `${PI_CODING_AGENT_DIR}/mcp-adapter.json` or `.pi/mcp-adapter.json`; `mcporter` does not rewrite native Pi files, automatically migrate their fields, or write user files on their behalf. Top-level adapter `settings`, `imports`, and plugin configuration likewise belong in `mcp-adapter.json`.

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

## Pin update and rollback

The `5.0.0` value is a packaged default for future TLH install/update merges. Changing this manifest pin does not replace the package or rewrite configuration in an already-running profile; an existing session keeps its current adapter until that profile is updated and restarted/reloaded as appropriate.

To roll back the packaged default for a future install/update, restore the manifest pin and this documentation to `npm:@diegopetrucci/pi-mcp-adapter@2.36.0`. Do not alter a live profile as a way to undo the packaged default change.

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
