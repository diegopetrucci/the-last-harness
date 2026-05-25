# Trusted embedded subagents

TLH lets you add your own trusted markdown subagents inside the isolated TLH profile.

This is a **trusted extension point, not a sandbox**. If you give an embedded agent write-capable tools, it can edit files and run commands with the same local access a normal user-scope subagent would have.

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

For TLH-primary use, the supported pattern is:

- `package: embedded`
- `name: <slug>` where `<slug>` is lowercase letters, digits, and hyphens only
- runtime name: `embedded.<slug>`

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

With TLH primary agents enabled, **architect may use `embedded.<slug>` only when you explicitly ask for that trusted agent**.

Good examples:

```text
Use embedded.repo-helper to inspect the auth flow.
```

```text
Use my trusted embedded.repo-developer agent for this small fix.
```

Do not expect architect to proactively choose an embedded agent on your behalf.

## Safety and scope caveats

- Embedded agents are **user-scope only** when TLH primaries are enabled.
- Enabled TLH primaries force `agentScope: "user"` and `context: "fresh"` for embedded execution.
- Project-scoped `.pi/agents/**/*.md` embedded agents are **not** a supported path for TLH-primary embedded delegation.
- `Rush`, `product`, and `bug-hunter` do not run `embedded.*`; architect is the only TLH primary that can execute them.
- `embedded.*` is for **trusted, user-owned** agents. Do not treat it as a way to safely run repo-controlled prompts from untrusted repositories.
- If you disable TLH primaries, upstream subagent behavior still exists, but this guide documents only the supported primaries-enabled TLH flow above.

## Undo or remove an embedded agent

Delete the markdown file you added:

```sh
rm -f ~/.the-last-harness/agent/agents/repo-helper.md
```

Optionally remove the now-empty user agents directory:

```sh
rmdir ~/.the-last-harness/agent/agents 2>/dev/null || true
```

After removal, ask TLH to use the bundled minor agents instead, or just stop referring to the removed `embedded.<slug>` name.
