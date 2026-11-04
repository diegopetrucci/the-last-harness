# MCP

TLH uses Pi's native MCP support. Server configuration, OAuth, exposure modes, `/mcp`, `pi mcp`, and codemode behavior are owned by [Pi's MCP documentation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md); this page covers only what TLH adds or changes. The bundled `project-mcp-json` default (see `config/default-extensions.json`) adds loading of a project `.mcp.json`.

## Configuration locations

| Scope                      | File                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| TLH profile (user-level)   | `<agent-dir>/mcp.json` (by default `~/.the-last-harness/agent/mcp.json`)     |
| Project, Pi-native         | `.pi/mcp.json`, read only after project trust                                |
| Project, Claude Code–style | `.mcp.json`, loaded by `project-mcp-json` under Pi's project-trust semantics |

A `.pi/mcp.json` entry replaces a same-named profile entry. If a `.mcp.json` server has the same name as one in Pi's own `mcp.json`, the Pi entry wins. `project-mcp-json` reads only `<cwd>/.mcp.json` and does not walk parent directories; see the [package README](https://www.npmjs.com/package/@diegopetrucci/pi-project-mcp-json/v/0.1.4).

## Exposure and agents

Servers default to `codemode` exposure, so the packaged primary agents and minor agents declare `codemode` (not an MCP gateway tool) and call servers from scripts as `tools.mcp__<server>__<tool>(...)`. Servers you set to `direct` exposure are also reachable in subagents: with an explicit `--tools` allowlist containing `codemode`, TLH adds `mcp__*` so those tools are not hidden. See [Control tool exposure](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md#control-tool-exposure).

- Primary agents and `developer` may use MCP within their authorized scope; read-only minors are instructed to avoid mutations and escalate uncertain side effects. This is prompt guidance, not enforcement.
- The packaged `test-runner` is the intentional exception: it runs assigned `codemode` scripts verbatim, and those scripts may call tools that change server-side state. Its other restrictions are described under [Final-validation test-runner](subagents.md#final-validation-test-runner).

## Project trust and subagents

Project configuration (`.pi/mcp.json`, and `.mcp.json` via `project-mcp-json`) loads only in trusted projects. Subagents run headless and cannot show a trust prompt, so run `/trust` once in the project from an interactive session; the saved decision then applies to children. Details: [project trust](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/security.md#understand-project-trust).

## Authentication

Sign in with `/mcp login <server>` inside a TLH session (`/mcp` lists servers there). Shell `pi mcp` commands are not equivalent: bare `pi` does not select the TLH isolated profile and cannot see `.mcp.json` servers registered by `project-mcp-json`, so scope them explicitly with `PI_CODING_AGENT_DIR` and only expect native config files (`<agent-dir>/mcp.json`, `.pi/mcp.json`); tokens are stored in `<agent-dir>/mcp-auth.json`. Adapter-era credentials are not carried over, so re-login once after migrating. See [Authenticate with OAuth](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md#authenticate-with-oauth).

## What native MCP does not provide

Compared with the retired adapter, these are not available: per-server `approveTools`, keychain-backed credentials, lazy server lifecycle (servers connect at session start), `imports` and the shared `~/.config/mcp` / `~/.agents` configs, the SSE transport, and MCP UI, elicitation, sampling, and prompts.

## Migrating from the MCP adapter

TLH no longer bundles `pi-mcp-adapter` (formerly the `mcporter` default) or the `/mcp-auth` and `tlh defaults migrate-mcp` commands. A full install or `tlh update` removes ALL recognized adapter package selections from the isolated settings, including user-installed and pinned copies, and any TLH-managed `-builtin:mcp` exclusion. Your config files are never rewritten; `tlh update` and `tlh doctor` print a count-only warning that links here for anything native Pi ignores or rejects. Each category means:

| Warning                                         | Meaning                                                             | Fix                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server(s) with string `auth`                    | Native Pi rejects the server (for example `"auth": "oauth"`).       | Remove the `auth` field; OAuth is automatic for HTTP servers, then run `/mcp login <server>`. Use `headers` or `oauth` objects for anything else.                   |
| config file(s) using `imports`                  | Ignored.                                                            | Copy the imported servers into the files below.                                                                                                                     |
| server(s) using `lifecycle`                     | Ignored; servers connect at session start.                          | Remove the field.                                                                                                                                                   |
| server(s) using `directTools`                   | Ignored.                                                            | Remove it; use `exposure`/`toolExposure` (see [Pi docs](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md#control-tool-exposure)). |
| `mcp-adapter.json` file(s)                      | Never read.                                                         | Move the servers into `<agent-dir>/mcp.json`, or project `.pi/mcp.json` / `.mcp.json`, and delete the file.                                                         |
| shared config in `~/.config/mcp` or `~/.agents` | Never read.                                                         | Move the servers into `<agent-dir>/mcp.json`, or project `.pi/mcp.json` / `.mcp.json`.                                                                              |
| MCP adapter package(s) still installed          | An adapter is still in your isolated settings and would own `/mcp`. | Run a full `tlh update` (`tlh update --extensions` does not remove it).                                                                                             |
| `-builtin:mcp` exclusion                        | A hand-added exclusion not owned by TLH disables native MCP.        | Remove `"-builtin:mcp"` from `extensions` in the isolated `settings.json`.                                                                                          |

For converting entries from other clients, see [Migrate configuration from another client](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/mcp.md#migrate-configuration-from-another-client). Run `/reload` after editing, and `/mcp` to validate.

## Undo

To go back to the adapter-based behavior, reinstall the previous TLH release tag (see [pinned-tag installs and rollback](install.md)); the adapter and `/mcp-auth` return with it. Adapter-era config files you did not delete are still on disk.
