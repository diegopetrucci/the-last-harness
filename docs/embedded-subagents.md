# Trusted embedded subagents

TLH lets you add your own trusted markdown subagents inside the isolated TLH profile. This feature is **disabled by default** and gated behind the `embedded-subagents` experimental flag.

## Enable the flag

```text
/experimental enable embedded-subagents
```

Then **start a new session** — the runtime snapshots `tlh.experimental` at session start, so enabling or disabling the flag takes effect only in the next session, not mid-session.

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

If you installed TLH with a custom `--agent-dir`, use the same `agents/**/*.md` structure under that custom profile directory instead.

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
- runtime name: `embedded.<slug>`

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

Enabling the flag and placing the agent file in the supported location is what authorizes architect to delegate to that agent. The "only when the user explicitly names or asks for it" rule in the architect system prompt is **prompt policy, not a runtime gate** — the runtime does not verify that the user typed the agent name. If you enable the flag and the file exists, the architect primary agent is authorized to run it.

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

With TLH primary agents enabled and the flag on, the architect primary may delegate to `embedded.<slug>` agents. The system prompt instructs architect to do so only when you explicitly name or ask for that trusted agent — but again, that is prompt policy, not a hard runtime check.

Good examples:

```text
Use embedded.repo-helper to inspect the auth flow.
```

```text
Use my trusted embedded.repo-developer agent for this small fix.
```

The `rush`, `product`, and `bug-hunter` primaries are **hard-blocked** from running embedded targets at runtime — only architect can execute them.

When flag is **off** (the default), any `embedded.*` target is blocked the same way an unknown agent name would be. No embedded-specific behavior exists.

## Safety and scope caveats

- This is a **trusted extension point, not a sandbox**. If you give an embedded agent write-capable tools, it can edit files and run commands with the same local access a normal user-scope subagent would have.
- Embedded agents are **user-scope only** when TLH primaries are enabled. The runtime forces `agentScope: "user"` and `context: "fresh"` for embedded execution.
- `embedded.*` is for **trusted, user-owned** agents. Do not treat it as a way to safely run repo-controlled prompts from untrusted repositories.
- Project-scoped `.pi/agents/**/*.md` embedded agents are **not** a supported path for TLH-primary embedded delegation.
- `rush`, `product`, and `bug-hunter` do not run `embedded.*`; architect is the only TLH primary that can execute them.
- If you disable TLH primaries, upstream subagent behavior still exists, but this guide documents only the supported primaries-enabled TLH flow above.

## Undo or remove an embedded agent

To stop using an embedded agent, disable the flag:

```text
/experimental disable embedded-subagents
```

Then start a new session for the change to take effect.

To fully remove the agent file:

```sh
rm -f ~/.the-last-harness/agent/agents/repo-helper.md
```

Optionally remove the now-empty user agents directory:

```sh
rmdir ~/.the-last-harness/agent/agents 2>/dev/null || true
```

Both steps together — disabling the flag and deleting the file — fully undo the feature.
