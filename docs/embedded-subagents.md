# Trusted embedded subagents

TLH lets you add your own trusted markdown subagents inside the isolated TLH profile. This feature is **disabled by default** and gated behind the `embedded-subagents` experimental flag.

## Enable the flag

```text
/experimental enable embedded-subagents
```

Then **start a new session or run `/reload`** — the runtime snapshots `tlh.experimental` when a session starts or explicitly reloads, so enabling or disabling the flag does not affect the active runtime until one of those activation boundaries.

To disable it again:

```text
/experimental disable embedded-subagents
```

You can also check current state with `/experimental status embedded-subagents` or list all flags with `/experimental list`.

## Supported location and runtime name

Create user-owned embedded agents here:

```text
~/.the-last-harness/agent/agents/**/*.md
```

If you installed TLH with a custom `--agent-dir`, use the same `agents/**/*.md` structure under that custom profile directory instead. Definitions beneath any nested `.agents/skills` path are excluded from agent discovery and cannot authorize embedded delegation.

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

## Authorization model

Enabling the flag and placing the agent file in the supported location is what authorizes architect to delegate to that agent. At execution time, TLH re-scans only the active isolated profile's `agents/**/*.md` tree, excludes definitions beneath nested `.agents/skills` paths, follows the pinned upstream discovery order for the remaining same-name profile definitions, and authorizes only runtime names whose **last effective same-name profile definition** is a currently readable, valid, regular non-symlink `.md` file with `package: embedded`, `name: <slug>`, and a non-empty `description`. Files ending in `.chain.md` also do not authorize embedded delegation or participate in same-name selection. A later same-name symlink therefore blocks an earlier regular authorizer, while a later valid regular file may supersede an earlier same-name symlink. Same-name agents that exist only in symlinks, installed packages, or configured `subagents.agentDirs` stay blocked for TLH-primary embedded delegation. Deleting or breaking the selected profile file is observed on the next embedded delegation attempt.

The "only when the user explicitly names or asks for it" rule in the architect system prompt is still **prompt policy, not a runtime gate** — the runtime does not verify that the user typed the agent name.

**Known limitation — opaque resume is not re-checked against the architect-only rule.** TLH now treats `subagent({ action: "resume", chain: [...] })` as fresh execution and re-runs the normal embedded-target gates. The remaining accepted issue #330 limitation applies only to *opaque* resume calls that continue an already-started run by id/index without an attached execution chain. If architect starts an embedded subagent run and the user then switches the primary agent (via `/switch-primary-agent`) to `product` or `bug-hunter` within the same session, that non-architect primary can still opaque-`resume` the already-started embedded run; the runtime does not re-check the resumed run's initiating agent against the architect-only rule. This is a known, accepted defense-in-depth gap, not a sandbox escape: embedded subagents are trusted, user-owned agents (as noted below), so this is a defense-in-depth boundary rather than isolation of untrusted code. It is tracked for a proper fix (threading the resumed run's agent identity into the gate) in issue #330.

## Least-privilege starter

Start with a read-only helper unless you really need mutation:

```md
---
name: repo-helper
package: embedded
description: Trusted read-only helper for focused repository inspection
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

With TLH primary agents enabled and the flag on, the architect primary may delegate to `embedded.<slug>` agents only when a matching valid profile file currently exists under the active TLH profile's `agents/**/*.md` tree outside nested `.agents/skills` paths. The system prompt also instructs architect to do so only when you explicitly name or ask for that trusted agent — but again, that user-naming rule is prompt policy, not a hard runtime check.

Good examples:

```text
Use embedded.repo-helper to inspect the auth flow.
```

```text
Use my trusted embedded.repo-developer agent for this small fix.
```

The `rush`, `product`, and `bug-hunter` primaries are blocked from **initiating** delegation to embedded targets at runtime — including `resume.chain` attached execution. The accepted issue #330 opaque-resume limitation described above still applies to already-started runs.

When flag is **off** (the default), any `embedded.*` target is blocked the same way an unknown agent name would be. No embedded-specific behavior exists.

## Safety and scope caveats

- This is a **trusted extension point, not a sandbox**. If you give an embedded agent write-capable tools, it can edit files and run commands with the same local access a normal user-scope subagent would have.
- Embedded agents are **user-scope only** when TLH primaries are enabled. The runtime forces `agentScope: "user"` and `context: "fresh"` for embedded execution.
- Authorization comes only from the last effective same-name valid profile-owned definition under the active TLH profile's `agents/**/*.md` tree outside nested `.agents/skills` paths, and that selected definition must be a regular non-symlink `.md` file; `.chain.md` files, installed-package agents, and `subagents.agentDirs` do not authorize `embedded.*` runtime names for TLH-primary delegation.
- `embedded.*` is for **trusted, user-owned** agents. Do not treat it as a way to safely run repo-controlled prompts from untrusted repositories.
- Project-scoped `.pi/agents/**/*.md` embedded agents are **not** a supported path for TLH-primary embedded delegation.
- `rush`, `product`, and `bug-hunter` cannot initiate `embedded.*` runs, including via `resume.chain`; architect is the only TLH primary that can initiate them. See the accepted issue #330 opaque-resume limitation above for already-started runs.
- If you disable TLH primaries, upstream subagent behavior still exists, but this guide documents only the supported primaries-enabled TLH flow above.

## Undo or remove an embedded agent

To stop using an embedded agent, disable the flag:

```text
/experimental disable embedded-subagents
```

Then start a new session or run `/reload` for the flag change to take effect.

To fully remove the agent file:

```sh
rm -f ~/.the-last-harness/agent/agents/repo-helper.md
```

Optionally remove the now-empty user agents directory:

```sh
rmdir ~/.the-last-harness/agent/agents 2>/dev/null || true
```

Both steps together — disabling the flag and deleting the file — fully undo the feature. Deleting the file alone also revokes authorization for later `embedded.<slug>` delegations immediately, even before you disable the flag.
