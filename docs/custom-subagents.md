# Trusted custom subagents

TLH supports two stable, always-available custom-subagent sources. Profile-owned agents live in the active isolated TLH profile and use the `embedded.<slug>` runtime name; the architect primary agent or disabled primary mode may delegate to one when a valid profile definition authorizes it. Project-owned agents live under the canonical Git worktree's `.tlh/agents/` directory and are requested naturally by slug after project/session approval. Both are trusted extension points, not sandboxes; their source, authorization, naming, refresh, and control rules differ as documented below. Disabled mode keeps profile-owned trusted delegation and its safety gates without injecting the architect persona.

## Two supported sources

| Source            | Owner and definition path                                                                                                            | Request identity                                                                                                         | Authorization and refresh                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Profile-owned** | User-owned Markdown under the active isolated profile's `agents/**/*.md` tree                                                        | Exact runtime name `embedded.<slug>`                                                                                     | A valid file is re-checked for each new embedded delegation; no `/reload` is needed for authorization changes.                    |
| **Project-owned** | Project-owned Markdown under the canonical Git worktree's `.tlh/agents/<slug>.md` path (the loader also accepts bounded descendants) | Ask the architect naturally for the project subagent by `<slug>`; `embedded.<slug>` is only an internal runtime identity | Trust/session approval captures an immutable generation. `/reload` or a new session is required to capture later project changes. |

The profile and project sections below intentionally keep these contracts separate. A project entry can participate in the limited profile fallback merge described in [Profile/project precedence and tombstones](#profileproject-precedence-and-tombstones), but project content does not change how profile authorization, settings overrides, or profile controls work.

## Profile-owned custom subagents

### Supported location and runtime name

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

### Frontmatter

Frontmatter is YAML-style metadata between the opening and closing `---` lines. The fields above are required for TLH authorization. Common optional fields let you narrow the child or choose its runtime behavior:

| Field                    | Effect                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`                  | Comma-separated tool allowlist. Set this explicitly to least privilege; omitting it does not make a trusted agent a sandbox.                                                                                                                                  |
| `model`                  | Default model for the child when the caller or TLH runtime does not inject a model override. TLH-primary OpenRouter delegation follows the current session model instead of this frontmatter model.                                                           |
| `fallbackModels`         | Comma-separated ordered fallback models for model/provider failures.                                                                                                                                                                                          |
| `thinking`               | Thinking level applied to the selected model when it has no existing suffix.                                                                                                                                                                                  |
| `systemPromptMode`       | `replace` or `append` to keep the normal base prompt. Defaults are name-dependent: the legal slug `delegate` uses `append`; other names default to `replace`. Set it explicitly when you need predictable behavior.                                           |
| `inheritProjectContext`  | `true` keeps inherited project instructions such as `AGENTS.md`; `false` keeps the prompt narrower. Defaults are name-dependent: the legal slug `delegate` uses `true`; other names default to `false`. Set it explicitly when you need predictable behavior. |
| `inheritSkills`          | `true` keeps the parent's discovered skills catalog; `false` (the default) prevents that inheritance.                                                                                                                                                         |
| `skill` or `skills`      | Comma-separated names of specific skills to make available to the child. This is separate from `inheritSkills`.                                                                                                                                               |
| `defaultContext`         | Optional `fresh` or `fork` default when a caller omits context. TLH-primary embedded delegation always forces `fresh`.                                                                                                                                        |
| `acceptanceRole`         | `read-only` or `writer` hint for automatic acceptance inference. It does not grant or revoke tools.                                                                                                                                                           |
| `extensions`             | Comma-separated extension paths for the child. Treat any extension that adds tools as part of the trusted execution surface.                                                                                                                                  |
| `subagentOnlyExtensions` | Comma-separated extension paths loaded only in the spawned child.                                                                                                                                                                                             |
| `output`                 | Default output file for a single-agent run.                                                                                                                                                                                                                   |
| `defaultReads`           | Comma-separated files used as default reads where the runtime supports them.                                                                                                                                                                                  |
| `defaultProgress`        | Whether the child maintains a progress file by default.                                                                                                                                                                                                       |
| `completionGuard`        | Whether completion checks are enabled for this agent. Leave the default unless you understand the acceptance implications.                                                                                                                                    |
| `toolBudget`             | JSON object with optional `soft`, required `hard`, and optional `block` tool-budget controls.                                                                                                                                                                 |
| `maxSubagentDepth`       | Non-negative limit that can tighten nested delegation depth. Custom children still cannot spawn TLH subagents.                                                                                                                                                |
| `maxExecutionTimeMs`     | Positive safe-integer cumulative active-execution ceiling in milliseconds. A caller timeout can tighten but not loosen it.                                                                                                                                    |
| `interactive`            | Parsed for compatibility but not enforced by the current runtime.                                                                                                                                                                                             |

A frontmatter field is configuration, not a security boundary. In particular, `tools`, `extensions`, inherited context, and the markdown body all come from a trusted user-owned file. The least-privilege example below shows a conservative starting point.

### Settings overrides and precedence

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

### Authorization model

Placing the agent file in the supported location is what authorizes the architect or disabled primary mode to delegate to that agent. At execution time, TLH re-scans only the active isolated profile's `agents/**/*.md` tree, excludes definitions beneath nested `.agents/skills` paths, follows the pinned upstream discovery order for the remaining same-name profile definitions, and authorizes only runtime names whose **last effective same-name profile definition** is a currently readable, valid, regular non-symlink `.md` file with `package: embedded`, `name: <slug>`, and a non-empty `description`. Files ending in `.chain.md` also do not authorize embedded delegation or participate in same-name selection. A later same-name symlink therefore blocks an earlier regular authorizer, while a later valid regular file may supersede an earlier same-name symlink. Same-name agents that exist only in symlinks, installed packages, or configured `subagents.agentDirs` stay blocked for TLH-primary embedded delegation. Deleting or breaking the selected profile file is observed on the next embedded delegation attempt.

The "only when the user explicitly names or asks for it" rule in the architect and disabled-mode system prompts is still **prompt policy, not a runtime gate** — the runtime does not verify that the user typed the agent name.

### Reload and file changes

Authorization is checked against the current active profile on each new embedded delegation attempt. Adding, editing, moving, or deleting a profile definition therefore does not require a flag change or `/reload` to update the authorization result. Each new child run reads the selected agent definition; an already-running child keeps the configuration it started with. `/reload` remains useful after changing other TLH resources such as extensions, skills, prompts, or themes, but it is not an activation boundary for custom-agent authorization.

**Known limitation — opaque resume and opaque steer are not re-checked against the architect/disabled initiation rule.** All resume and steer calls are opaque; TLH does not re-run the embedded-target gates on resume or steer. If architect or disabled mode starts an embedded subagent run and the user then switches the primary agent (via `/switch-primary-agent`) to `product` or `bug-hunter` within the same session, that non-architect primary can still opaque-`resume` or opaque-`steer` the already-started embedded run; the runtime does not re-check the run's initiating agent against the architect/disabled initiation rule. `rush` is not covered by this gap — it is blocked from both opaque resume and opaque steer at runtime. This is a known, accepted defense-in-depth gap, not a sandbox escape: embedded subagents are trusted, user-owned agents (as noted below), so this is a defense-in-depth boundary rather than isolation of untrusted code. It is tracked for a proper fix (threading the run's agent identity into the gate) in issue #330.

### Least-privilege starter

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

### Advanced full-tools developer-like starter

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

### How to ask TLH to use one

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

### Validation and troubleshooting

Before asking TLH to use an agent, check the definition itself:

1. Confirm it is beneath the active profile's `agents/` directory, not the normal `~/.pi/agent` profile, a project `.pi/agents/` directory, an installed package, or a configured `subagents.agentDirs` directory.
2. Confirm the path ends in `.md`, is not a `.chain.md` file, and is a regular non-symlink file. The `agents/` root itself must also not be a symlink.
3. Confirm `package: embedded`, a lowercase slug in `name`, and a non-empty `description` appear in the frontmatter.
4. Confirm the runtime name is exactly `embedded.<slug>` and that the active `--agent-dir`/`PI_CODING_AGENT_DIR` is the profile containing the file.
5. Ask the architect or disabled primary mode using that exact runtime name. A blocked request names the unauthorized target; use that message to correct the path, same-name collision, or frontmatter.

`/subagents-doctor` and `subagent({ action: "doctor" })` provide general runtime and discovery diagnostics. `tlh doctor` checks installer-owned profile resources; it does not replace the embedded authorization checks above. If a child starts but behaves unexpectedly, inspect its `tools`, prompt mode, context inheritance, skills, extensions, and markdown body. Existing children are not retroactively changed when their definition is edited.

### Safety, trust, and scope caveats

- This is a **trusted extension point, not a sandbox**. If you give an embedded agent write-capable tools, it can edit files and run commands with the same local access a normal user-scope subagent would have.
- For TLH primary-agent dispatch, embedded agents are **user-scope only** and the runtime forces `agentScope: "user"` and `context: "fresh"`; architect and disabled primary mode can initiate new embedded runs.
- Authorization comes only from the last effective same-name valid profile-owned definition under the active TLH profile's `agents/**/*.md` tree outside nested `.agents/skills` paths, and that selected definition must be a regular non-symlink `.md` file; `.chain.md` files, installed-package agents, and `subagents.agentDirs` do not authorize `embedded.*` runtime names for TLH-primary delegation.
- `embedded.*` is for **trusted, user-owned** agents. Do not treat it as a way to safely run repo-controlled prompts from untrusted repositories.
- Project-scoped `.pi/agents/**/*.md` embedded agents are **not** a supported path for TLH-primary embedded delegation.
- `rush`, `product`, and `bug-hunter` cannot initiate `embedded.*` runs; architect and disabled primary mode can initiate them. `rush` is also blocked from opaque resume and opaque steer of already-started runs. See the accepted issue #330 limitation above for the residual gap that applies only to `product` and `bug-hunter`.
- Disabled primary mode retains this trusted embedded-agent flow while omitting the architect persona; if the TLH primary-agent runtime is not loaded at all, upstream subagent behavior still exists but is outside this guide.

### Remove or roll back a custom agent

To stop using an embedded agent, remove its profile file:

```sh
rm -f ~/.the-last-harness/agent/agents/repo-helper.md
```

To temporarily disable it without deleting the file, move it outside the active profile's `agents/` tree. Restore it there when you want the next delegation attempt to authorize it again. Optionally remove the now-empty user agents directory:

```sh
rmdir ~/.the-last-harness/agent/agents 2>/dev/null || true
```

Deleting or moving the file revokes authorization for later `embedded.<slug>` delegations immediately; it does not alter an already-running child. Interrupt or stop an existing run using the normal subagent controls. To roll back an edit to an agent definition, restore the file from your own backup and verify its frontmatter before the next delegation attempt.

## Project-owned custom subagents

Project custom subagents are a separate source from profile-owned `embedded.<slug>` agents. They let a trusted project provide a narrowly defined helper without asking the user to copy that definition into the active profile. The project source is still a trusted extension point: its Markdown body, tools, model settings, skills, and inherited context can act with the local permissions granted to the child.

### Project path, runtime identity, and quick start

The supported project definition path is beneath the canonical Git worktree root:

```text
.tlh/agents/<slug>.md
```

The loader may inspect bounded descendant directories below `.tlh/agents/`, so the discovery form is `.tlh/agents/**/*.md`; the simple file above is the recommended user-facing layout. The `.tlh` component, `agents` directory, traversed directories, and definition files must be regular non-symlink paths. TLH does not use arbitrary project directories for this feature. Project-scoped `.pi/agents/**/*.md` files are **not** a supported path for project custom-subagent delegation.

Create a project definition such as `.tlh/agents/reviewer.md`:

```md
---
name: reviewer
package: embedded
description: Read-only reviewer for this project
tools: read, grep, find, ls
inheritProjectContext: false
inheritSkills: false
---

Review the requested project files and report concise findings. Do not edit files.
```

After the project is approved and the definition is loaded, ask the architect naturally by slug:

```text
Ask the reviewer project subagent to inspect the authentication flow.
```

You do not need to know or type the runtime's internal `embedded.reviewer` spelling for `.tlh/agents/reviewer.md`; asking for the `reviewer` project subagent by name is enough. The architect primary agent is the supported initiator and should use a project custom subagent only when you explicitly name or ask for it. This naming rule is prompt policy, not a runtime proof of what the user typed.

Project custom subagents are intentionally omitted from management `list` and `get` results. Use the project file, trust/reload diagnostics, and the canonical guide to inspect them; absence from those management results does not mean the project definition is invalid.

### Project definition and required frontmatter

Project definitions use UTF-8 Markdown with a strict YAML-style frontmatter block between the first two `---` delimiters. All of these fields are required for project authorization:

- **File name:** `<slug>.md`, where `<slug>` contains lowercase letters, digits, and hyphens, starts with a letter or digit, and has no dots or underscores. The `name` field must exactly equal the file basename without `.md`.
- **`name`:** the exact slug above.
- **`package`:** exactly `embedded`. This marker does not make the child safe or grant extra tools.
- **`description`:** a non-empty description.
- **`tools`:** explicitly declared with at least one usable runtime tool. Comma-separated `mcp:` entries are not usable here, and an `mcp:`-only list is rejected.

A missing or malformed delimiter, duplicate frontmatter key, invalid UTF-8 file, mismatched basename/name, invalid slug, missing description, or missing/empty tools field makes the candidate invalid. Invalid candidates are retained as a tombstone (see [Profile/project precedence and tombstones](#profileproject-precedence-and-tombstones)) rather than silently falling back to another definition.

The Markdown body is the project subagent's system prompt. Keep it narrow and explicit about the files, tools, and decisions the subagent may use. Project definitions may use these additional configuration fields when supported by the runtime:

| Field                                     | Meaning                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `tools`                                   | Comma-separated runtime tool names. Declare the smallest useful set.                |
| `model`                                   | Default model when TLH does not inject one.                                         |
| `fallbackModels`                          | Comma-separated ordered fallback models.                                            |
| `thinking`                                | Thinking level for the selected model.                                              |
| `systemPromptMode`                        | `replace` or `append`; set it explicitly when prompt composition matters.           |
| `inheritProjectContext`                   | Whether to keep inherited project instructions in the child prompt.                 |
| `inheritSkills`                           | Whether to keep the parent's discovered skills section in the child prompt.         |
| `skill` / `skills`                        | Comma-separated named skills to resolve for the child.                              |
| `defaultContext`                          | `fresh` or `fork`; project-agent dispatch requires a fresh child context.           |
| `acceptanceRole`                          | `read-only` or `writer` hint for acceptance handling; it is not a permission grant. |
| `output` / `defaultReads`                 | Default output or read paths where the run mode supports them.                      |
| `defaultProgress` / `completionGuard`     | Progress and completion behavior.                                                   |
| `interactive`                             | Parsed for compatibility; not an execution permission.                              |
| `maxSubagentDepth` / `maxExecutionTimeMs` | Limits that can only tighten execution.                                             |
| `toolBudget`                              | JSON tool-budget limits.                                                            |

`extensions` and `subagentOnlyExtensions` are **prohibited** in project definitions. A definition containing either field is invalid and cannot authorize execution. Project definitions cannot add arbitrary extensions or tools through frontmatter. Unknown fields are not authorization metadata; remove them unless the current TLH guide documents a use for them.

Frontmatter is configuration, not a security boundary. The tools, prompt, model settings, skills, and body all come from project-owned content that should be treated as trusted code and instructions.

### Project trust and session approval

Before reading project definition content, TLH establishes the canonical Git worktree root from the current working directory. It then evaluates the applicable saved trust decision, current runtime trust signal, and—when needed—a bounded session confirmation. The confirmation prompt reads **"Trust project-local TLH configuration?"** and describes repository-owned content under `.tlh` (agent definitions and model/effort defaults) for this session only. Approving once covers both project custom subagents and `.tlh/defaults.json` project model/effort defaults for the session; see [Project model/effort defaults](models.md#project-modeleffort-defaults) in `docs/models.md`.

- A denial, trust-store error, unavailable UI, timeout, or failed trust check fails closed; it does not degrade to an untrusted definition or a profile fallback.
- A session approval authorizes the captured project snapshot for that session. A saved trust policy may apply the decision according to the user's normal project-trust settings.
- Trust is separate from the definition's `package` marker and from the model's request. Typing a name does not bypass trust.
- If no project definition directory exists, TLH registers an empty project snapshot without asking for project trust. A directory that appears later is inactive until a subsequent session-start load or `/reload` establishes a new snapshot.

Profile-owned definitions do not use this project trust/session approval gate; their separate authorization model is documented above.

### Profile/project precedence and tombstones

Project definitions are loaded into an immutable snapshot and merged after the active isolated profile's user-scope custom definitions for the execution path. This is a narrow source merge, not generic discovery or a replacement for profile authorization:

1. A valid project entry takes precedence over a matching profile custom `package: embedded` entry.
2. A malformed, duplicate, unsafe, or otherwise invalid project candidate creates a **tombstone** for its name. The tombstone removes a matching profile custom fallback instead of allowing invalid project content to fall through to a different definition.
3. A user-disabled project entry is also treated as a tombstone for that snapshot.
4. Project entries and tombstones may replace or remove only matching user-owned custom profile definitions. A collision with an unrelated bundled, package, or non-custom definition fails closed rather than silently overriding it.
5. A valid project entry does not authorize arbitrary profile/package/project discovery. Only the captured project snapshot and the permitted active-profile custom fallback are considered.

For a trusted project snapshot, the active isolated profile's `subagents.defaultModel` fills an omitted project `model`, and a matching active-profile `subagents.agentOverrides["embedded.<slug>"]` can fill other project fields omitted from frontmatter. Explicit project frontmatter wins per field. Because valid project agents must explicitly declare `tools`, a profile override cannot broaden project tools. A matching `disabled: true` profile override creates the documented project tombstone and removes the same-name profile fallback for that snapshot. Repository/project-scope `.pi/settings.json` overrides are deliberately ignored for project-agent effective settings; only the active isolated profile settings participate.

These settings are applied only after the project content has been loaded into a trusted snapshot. Overrides neither authorize project content nor make project paths discoverable. A typo, duplicate basename, broken symlink, disallowed path, or prohibited field can intentionally make a name unavailable rather than unexpectedly selecting another prompt.

### Project reloads and immutable generations

TLH captures one immutable project snapshot per session start or `/reload`. The snapshot records the exact definition bytes' digest, canonical project root, initiating session, process identity, generation, and effective configuration.

- A new project definition, edit, removal, or trust decision becomes part of a new generation after `/reload` (or a new session).
- A child that is already running keeps the exact configuration and generation with which it started.
- A same-session, same-process resume of a retained project run uses its original generation, even if the source file was edited, removed, or the branch changed after the run started.
- A new run after reload uses the newly captured generation.
- Project generation capabilities are process-private. Safe provenance and configuration metadata may appear in status/artifact records, but the authority-bearing capability is never serialized.

This differs from profile authorization: profile definitions are re-scanned for each new embedded delegation, and profile file changes do not require `/reload` to update authorization. `/reload` is the activation boundary for a new project generation, not for the profile authorization check.

### Project resume, steer, restart, and persisted markers

Project `resume` and `steer` require the private retained run reference plus independent checks for session, process, canonical root/cwd, generation, source, selected entry, digest, effective configuration, and current trust. A persisted `status.json`, result, transcript, or marker can describe a project run, but it can never grant execution authority.

Consequently, project-agent resume fails closed after a process restart (process-restart) and after a genuine new session (new-session). It also fails closed when the private reference is missing, ambiguous, revoked, or trust reauthorization fails. A project marker found only on disk is a **deny-only signal**: it prevents TLH from treating the request as an ordinary profile run or silently rediscovering mutable content, but it does not authorize resume or steer. This remains true when result files or status directories are copied, edited, or forged.

Read-only `status` and safe `interrupt` behavior do not require execution authority in the same way. They may report or stop a run when their ordinary lifecycle checks allow it; they do not turn persisted metadata into a resume capability.

Async project runs can be inspected, interrupted, paused, resumed, and steered within those same authority limits. Durable pause/resume does not survive a process restart or new session for project execution. Nested project-agent delegation is not supported; a project child cannot use this feature to delegate another project child.

The profile source has a different accepted control limitation: its opaque resume and steer behavior is not re-checked against the architect-only rule, as documented in [Reload and file changes](#reload-and-file-changes) above and tracked in issue #330. The project source instead requires the process-private retained reference and fails closed when the session, process, generation, trust, or provenance checks do not match.

### Project execution boundaries

Every project execution path is confined before a child starts:

- The root is the canonical Git worktree, not a caller-supplied arbitrary project path.
- The requested run cwd and each task cwd must exist, resolve through symlinks, and remain inside that canonical root.
- A path outside the root, a missing directory, a symlinked project-agent path, or a canonicalization failure fails closed.
- Project-agent dispatch **requires** user-scope execution and a fresh child context; a non-user scope or non-fresh context is rejected, not coerced.
- Project definitions do not become a generic public scope, and the ordinary model-facing scope selector cannot manufacture or authorize one.

The loader also applies finite bounds: at most 128 candidate files, 512 KiB per file, 8 MiB total definition bytes, depth 16, 256 directories, and three bounded scan attempts. These bounds prevent an untrusted or unexpectedly large repository tree from turning session start into unbounded work. An unreadable or dangling symlink anywhere under `.tlh/agents` makes the whole scan unavailable and activates no entries; TLH does not skip that path.

### Project skills and inherited context are live inputs

The project definition and its provenance are captured for the generation, but referenced skills and inherited context are deliberately resolved for the child at execution time:

- `skill` / `skills` names are looked up against the live skill locations for the task cwd and the runtime cwd fallback. Editing a referenced `SKILL.md` changes what a later child reads; it does not rewrite the captured project definition.
- `inheritProjectContext: true` keeps the relevant inherited project-instruction section in the child prompt; `false` removes it. Set the field explicitly when the boundary matters.
- `inheritSkills: true` keeps the parent's discovered skills section; `false` removes it. Explicit named skills are separate from inherited skills.
- A missing named skill is reported according to normal subagent behavior; it is not a way to bypass project trust or provenance checks.
- The captured Markdown body remains the project agent's own prompt. It should not assume that live skills or context are immutable.

### Project natural-language requests and prompt policy

The supported user experience is a natural request by the slug, for example:

```text
Use the reviewer project subagent to check the latest API change.
```

The architect prompt instructs the primary agent to use project custom subagents only when the user explicitly names or asks for one. That is **prompt policy**, not a runtime proof: the executor can validate the trusted snapshot and requested target, but it cannot prove which words the user typed or prevent a model from making a policy mistake. Trust, provenance, root confinement, and private-reference checks remain runtime boundaries.

### Project security boundaries

Project custom subagents are a trusted extension point, not a sandbox. A definition with write, shell, network, or other powerful tools can act with the local permissions available to its child process. Review the Markdown body, tools, model settings, skills, and inherited-context flags as one trusted execution surface.

The main project security boundaries are:

- project content is read only from the fixed canonical `.tlh/agents` tree after trust evaluation;
- definitions and traversed paths must be regular non-symlink files/directories;
- strict required metadata and finite scan limits reject ambiguous or oversized candidates;
- prohibited extension fields prevent project content from loading arbitrary child extensions;
- immutable generations prevent a running child from silently changing configuration through file edits;
- process-private capabilities, trust reauthorization, and exact provenance checks are required for project execution controls;
- persisted files are evidence or deny-only markers, never authority.

Do not copy a project definition into another project and assume its approval, generation, or run references transfer. Each canonical root, session, process, and generation is checked independently.

### Project troubleshooting

If a requested project custom subagent is unavailable:

1. Confirm the shell is inside the intended Git worktree and the definition is at `.tlh/agents/<slug>.md`.
2. Confirm the filename and frontmatter `name` match exactly, the slug uses only lowercase letters/digits/hyphens, and `package: embedded`, `description`, and `tools` are present.
3. Remove `extensions` and `subagentOnlyExtensions`; they invalidate project definitions. Check that the tools list contains at least one usable non-`mcp:` tool.
4. Check for duplicate basenames, symlinks, malformed delimiters, oversized files, and invalid UTF-8. A broken candidate may intentionally tombstone a same-name profile fallback.
5. Approve the project when TLH asks, then run `/reload` so the current session captures a new generation. A trust denial or unavailable confirmation is expected to block loading.
6. Ask by the exact slug in natural language. Internal diagnostic output may show a namespaced runtime identity, but that spelling is not required for the request.
7. Project agents are intentionally absent from management `list`/`get`; that is expected. Use the definition path and `/subagents-doctor` or `subagent({ action: "doctor" })` for diagnostics.
8. `tlh doctor` checks installed TLH resources; it does not replace project-agent trust or provenance checks.
9. If the failure concerns resume after a restart or new session, start a new project run after approval and reload. Persisted status/result files cannot revive a private authority reference.

If a child starts with unexpected behavior, inspect its captured body and frontmatter plus the live referenced skills/context. Existing children do not change when the source file is edited.

### Remove or undo a project custom agent

To stop authorizing a project custom subagent for later runs, remove or move its definition outside `.tlh/agents/`, then run `/reload`:

```sh
rm -f .tlh/agents/reviewer.md
```

Moving the file is useful when you want to keep a local backup:

```sh
mkdir -p .tlh/agents-disabled
mv .tlh/agents/reviewer.md .tlh/agents-disabled/
```

Removal or movement revokes authorization for later generations; it does not rewrite an already-running child or erase its captured prompt. Use normal `interrupt`/stop controls for an existing run. Removing the last definition does not remove the project directory automatically, and TLH does not modify the installed profile as part of project-agent removal.

To undo an edit, restore the intended Markdown file from your own backup, verify its required frontmatter, and `/reload` before starting the next run. If a malformed replacement currently tombstones a profile fallback, fix or remove that candidate and reload.

### Project compatibility pointer

For older links, [docs/embedded-subagents.md](embedded-subagents.md) points back to this guide. Profile-owned custom-agent removal and rollback are documented in [Remove or roll back a custom agent](#remove-or-roll-back-a-custom-agent).
