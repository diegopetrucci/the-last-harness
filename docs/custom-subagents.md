# Trusted custom subagents

TLH supports stable, always-available user-owned custom subagents in the active isolated TLH profile. The architect primary agent or disabled primary mode may delegate to one when a valid profile definition authorizes it. The runtime name remains `embedded.<slug>`. Disabled mode keeps this trusted delegation and its safety gates without injecting the architect persona.

## Supported location and runtime name

Create user-owned custom agents here:

```text
~/.the-last-harness/agent/agents/**/*.md
```

If you installed TLH with a custom `--agent-dir`, use the same `agents/**/*.md` structure under that active profile directory instead. Definitions beneath any nested `.agents/skills` path are excluded from agent discovery and cannot authorize embedded delegation.

Create the directory if it does not exist yet:

```sh
mkdir -p ~/.the-last-harness/agent/agents
```

Do **not** put them under TLH's installer-owned bundled directory:

```text
~/.the-last-harness/agent/tlh/agents/subagents/
```

For TLH-primary use, the required frontmatter fields are:

- `package: embedded`
- `name: <slug>` where `<slug>` is lowercase letters, digits, and hyphens only, and must not start with a hyphen
- `description: <text>` with a non-empty value

The resulting runtime name is `embedded.<slug>`.

The runtime enforces the slug pattern `/^embedded\.[a-z0-9][a-z0-9-]*$/` — uppercase letters, dots after the prefix, underscores, and leading hyphens are all rejected.

Example file:

```text
~/.the-last-harness/agent/agents/repo-helper.md
```

```yaml
---
name: repo-helper
package: embedded
description: Trusted read-only helper for repository inspection
---
```

That file registers as `embedded.repo-helper`.

Project-scoped `.pi/agents/**/*.md` files are **not** a supported path for TLH-primary embedded delegation.

## Frontmatter

Frontmatter is YAML-style metadata between the opening and closing `---` lines. The fields above are required for TLH authorization. Common optional fields let you narrow the child or choose its runtime behavior:

| Field | Effect |
| --- | --- |
| `tools` | Comma-separated tool allowlist. Set this explicitly to least privilege; omitting it does not make a trusted agent a sandbox. |
| `model` | Default model for the child when the caller or TLH runtime does not inject a model override. TLH-primary OpenRouter delegation follows the current session model instead of this frontmatter model. |
| `fallbackModels` | Comma-separated ordered fallback models for model/provider failures. |
| `thinking` | Thinking level applied to the selected model when it has no existing suffix. |
| `systemPromptMode` | `replace` or `append` to keep the normal base prompt. Defaults are name-dependent: the legal slug `delegate` uses `append`; other names default to `replace`. Set it explicitly when you need predictable behavior. |
| `inheritProjectContext` | `true` keeps inherited project instructions such as `AGENTS.md`; `false` keeps the prompt narrower. Defaults are name-dependent: the legal slug `delegate` uses `true`; other names default to `false`. Set it explicitly when you need predictable behavior. |
| `inheritSkills` | `true` keeps the parent's discovered skills catalog; `false` (the default) prevents that inheritance. |
| `skill` or `skills` | Comma-separated names of specific skills to make available to the child. This is separate from `inheritSkills`. |
| `defaultContext` | Optional `fresh` or `fork` default when a caller omits context. TLH-primary embedded delegation always forces `fresh`. |
| `acceptanceRole` | `read-only` or `writer` hint for automatic acceptance inference. It does not grant or revoke tools. |
| `extensions` | Comma-separated extension paths for the child. Treat any extension that adds tools as part of the trusted execution surface. |
| `subagentOnlyExtensions` | Comma-separated extension paths loaded only in the spawned child. |
| `output` | Default output file for a single-agent run. |
| `defaultReads` | Comma-separated files used as default reads where the runtime supports them. |
| `defaultProgress` | Whether the child maintains a progress file by default. |
| `completionGuard` | Whether completion checks are enabled for this agent. Leave the default unless you understand the acceptance implications. |
| `toolBudget` | JSON object with optional `soft`, required `hard`, and optional `block` tool-budget controls. |
| `maxSubagentDepth` | Non-negative limit that can tighten nested delegation depth. Custom children still cannot spawn TLH subagents. |
| `maxExecutionTimeMs` | Positive safe-integer cumulative active-execution ceiling in milliseconds. A caller timeout can tighten but not loosen it. |
| `interactive` | Parsed for compatibility but not enforced by the current runtime. |

A frontmatter field is configuration, not a security boundary. In particular, `tools`, `extensions`, inherited context, and the markdown body all come from a trusted user-owned file. The least-privilege example below shows a conservative starting point.

## Settings overrides and precedence

The active profile's `settings.json` can provide omitted agent fields through a matching `subagents.agentOverrides["embedded.<slug>"]` entry:

```json
{
  "subagents": {
    "agentOverrides": {
      "embedded.repo-helper": {
        "model": "anthropic/claude-sonnet-4-6"
      }
    }
  }
}
```

An override can supply omitted overridable fields, including `model`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, execution settings, and `tools`. For non-model fields—including `tools`, prompt mode/context/skills, and execution settings—explicit frontmatter wins per field, so a settings override cannot replace a value the agent declares. Under TLH-primary delegation, stored `model` and `thinking` overrides are injected into the dispatch and take precedence over the custom agent's frontmatter `model`; a thinking-only override can pair with, or select, the current session model. When no stored model override is present, the OpenRouter rule in the `model` row still follows the current session model. For least privilege, declare `tools` explicitly as in the starter below; leaving `tools` out permits a matching settings override to provide a broader list. Overrides do not supply the agent's authorization metadata or markdown body.

## Authorization model

Placing the agent file in the supported location is what authorizes the architect or disabled primary mode to delegate to that agent. At execution time, TLH re-scans only the active isolated profile's `agents/**/*.md` tree, excludes definitions beneath nested `.agents/skills` paths, follows the pinned upstream discovery order for the remaining same-name profile definitions, and authorizes only runtime names whose **last effective same-name profile definition** is a currently readable, valid, regular non-symlink `.md` file with `package: embedded`, `name: <slug>`, and a non-empty `description`. Files ending in `.chain.md` also do not authorize embedded delegation or participate in same-name selection. A later same-name symlink therefore blocks an earlier regular authorizer, while a later valid regular file may supersede an earlier same-name symlink. Same-name agents that exist only in symlinks, installed packages, or configured `subagents.agentDirs` stay blocked for TLH-primary embedded delegation. Deleting or breaking the selected profile file is observed on the next embedded delegation attempt.

The "only when the user explicitly names or asks for it" rule in the architect and disabled-mode system prompts is still **prompt policy, not a runtime gate** — the runtime does not verify that the user typed the agent name.

## Reload and file changes

Authorization is checked against the current active profile on each new embedded delegation attempt. Adding, editing, moving, or deleting a profile definition therefore does not require a flag change or `/reload` to update the authorization result. Each new child run reads the selected agent definition; an already-running child keeps the configuration it started with. `/reload` remains useful after changing other TLH resources such as extensions, skills, prompts, or themes, but it is not an activation boundary for custom-agent authorization.

**Known limitation — opaque resume and opaque steer are not re-checked against the architect/disabled initiation rule.** All resume and steer calls are opaque; TLH does not re-run the embedded-target gates on resume or steer. If architect or disabled mode starts an embedded subagent run and the user then switches the primary agent (via `/switch-primary-agent`) to `product` or `bug-hunter` within the same session, that non-architect primary can still opaque-`resume` or opaque-`steer` the already-started embedded run; the runtime does not re-check the run's initiating agent against the architect/disabled initiation rule. `rush` is not covered by this gap — it is blocked from both opaque resume and opaque steer at runtime. This is a known, accepted defense-in-depth gap, not a sandbox escape: embedded subagents are trusted, user-owned agents (as noted below), so this is a defense-in-depth boundary rather than isolation of untrusted code. It is tracked for a proper fix (threading the run's agent identity into the gate) in issue #330.

## Least-privilege starter

Start with a read-only helper unless you really need mutation:

```md
---
name: repo-helper
package: embedded
description: Trusted read-only helper for focused local repository inspection
tools: read, grep, find, ls, contact_supervisor
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
defaultContext: fresh
---
You are a trusted embedded TLH subagent for focused local repository inspection.

Rules:
- Stay read-only.
- Inspect files and report findings concisely.
- Do not propose broad refactors.
- Do not make product decisions.
- If the task is ambiguous or blocked, use `contact_supervisor` instead of guessing.
```

Why this is the default:

- read-only tools are safer
- no inherited project context keeps the prompt narrower
- `defaultContext: fresh` matches TLH's primary-agent safety rules

## Advanced full-tools developer-like starter

Use this only for a subagent you fully trust to edit files and run commands:

```md
---
name: repo-developer
package: embedded
description: Trusted developer-like helper for bounded implementation tasks
tools: read, write, edit, grep, find, ls, bash, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
---
You are a trusted embedded TLH developer-like subagent.

Rules:
- Implement only the task you were given.
- Prefer the smallest correct change.
- Run narrow validation before finishing.
- Use `contact_supervisor` for ambiguity, blockers, or decisions instead of guessing.
- Do not launch or orchestrate other subagents.
```

This matches TLH's bundled developer-style tool set, but it is still your own trusted prompt and tool policy.

## How to ask TLH to use one

With the TLH primary-agent runtime active, the architect or disabled primary mode may delegate to `embedded.<slug>` agents only when a matching valid profile file currently exists under the active TLH profile's `agents/**/*.md` tree outside nested `.agents/skills` paths. The system prompt also instructs the active primary to do so only when you explicitly name or ask for that trusted agent — but again, this user-naming rule is prompt policy, not a hard runtime check.

Good examples:

```text
Use embedded.repo-helper to inspect the auth flow.
```

```text
Use my trusted embedded.repo-developer agent for this small fix.
```

The same request can be expressed by the architect or disabled primary mode through the model-facing tool as an execution with `agent: "embedded.repo-helper"` and a focused `task`. The runtime still requires the corresponding authorized profile file.

The `rush`, `product`, and `bug-hunter` primaries are blocked from **initiating** delegation to embedded targets at runtime; architect and disabled primary mode can initiate it. `rush` is additionally blocked from opaque resume and opaque steer of already-started runs, so the accepted issue #330 limitation described above applies only to `product` and `bug-hunter`.

## Validation and troubleshooting

Before asking TLH to use an agent, check the definition itself:

1. Confirm it is beneath the active profile's `agents/` directory, not the normal `~/.pi/agent` profile, a project `.pi/agents/` directory, an installed package, or a configured `subagents.agentDirs` directory.
2. Confirm the path ends in `.md`, is not a `.chain.md` file, and is a regular non-symlink file. The `agents/` root itself must also not be a symlink.
3. Confirm `package: embedded`, a lowercase slug in `name`, and a non-empty `description` appear in the frontmatter.
4. Confirm the runtime name is exactly `embedded.<slug>` and that the active `--agent-dir`/`PI_CODING_AGENT_DIR` is the profile containing the file.
5. Ask the architect or disabled primary mode using that exact runtime name. A blocked request names the unauthorized target; use that message to correct the path, same-name collision, or frontmatter.

`/subagents-doctor` and `subagent({ action: "doctor" })` provide general runtime and discovery diagnostics. `tlh doctor` checks installer-owned profile resources; it does not replace the embedded authorization checks above. If a child starts but behaves unexpectedly, inspect its `tools`, prompt mode, context inheritance, skills, extensions, and markdown body. Existing children are not retroactively changed when their definition is edited.

## Safety, trust, and scope caveats

- This is a **trusted extension point, not a sandbox**. If you give an embedded agent write-capable tools, it can edit files and run commands with the same local access a normal user-scope subagent would have.
- For TLH primary-agent dispatch, embedded agents are **user-scope only** and the runtime forces `agentScope: "user"` and `context: "fresh"`; architect and disabled primary mode can initiate new embedded runs.
- Authorization comes only from the last effective same-name valid profile-owned definition under the active TLH profile's `agents/**/*.md` tree outside nested `.agents/skills` paths, and that selected definition must be a regular non-symlink `.md` file; `.chain.md` files, installed-package agents, and `subagents.agentDirs` do not authorize `embedded.*` runtime names for TLH-primary delegation.
- `embedded.*` is for **trusted, user-owned** agents. Do not treat it as a way to safely run repo-controlled prompts from untrusted repositories.
- Project-scoped `.pi/agents/**/*.md` embedded agents are **not** a supported path for TLH-primary embedded delegation.
- `rush`, `product`, and `bug-hunter` cannot initiate `embedded.*` runs; architect and disabled primary mode can initiate them. `rush` is also blocked from opaque resume and opaque steer of already-started runs. See the accepted issue #330 limitation above for the residual gap that applies only to `product` and `bug-hunter`.
- Disabled primary mode retains this trusted embedded-agent flow while omitting the architect persona; if the TLH primary-agent runtime is not loaded at all, upstream subagent behavior still exists but is outside this guide.

## Remove or roll back a custom agent

To stop using an embedded agent, remove its profile file:

```sh
rm -f ~/.the-last-harness/agent/agents/repo-helper.md
```

To temporarily disable it without deleting the file, move it outside the active profile's `agents/` tree. Restore it there when you want the next delegation attempt to authorize it again. Optionally remove the now-empty user agents directory:

```sh
rmdir ~/.the-last-harness/agent/agents 2>/dev/null || true
```

Deleting or moving the file revokes authorization for later `embedded.<slug>` delegations immediately; it does not alter an already-running child. Interrupt or stop an existing run using the normal subagent controls. To roll back an edit to an agent definition, restore the file from your own backup and verify its frontmatter before the next delegation attempt.
