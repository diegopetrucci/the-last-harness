# Project custom subagents

TLH supports stable, always-available **project custom embedded subagents**. A project custom agent is a repository-controlled Markdown definition whose runtime name is `embedded.<slug>`. The `architect` primary agent and `disabled` primary mode may start one when its exact file, persisted project trust, and safety checks all pass. This is a trusted extension point, not a sandbox: a custom agent with write-capable tools can edit files and run commands with the local user's access.

This guide is about project custom agents. It is separate from the thirteen canonical packaged TLH roles and their project prompt appends; see [Per-agent project guidance](../README.md#per-agent-project-guidance) for those files.

## Canonical packaged roles and append files

Project prompt appends are plain Markdown files for these exact roles and paths:

| Packaged role | Exact append filename |
| --- | --- |
| `architect` | `.tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md` |
| `rush` | `.tlh/agents/builtin/RUSH_PROMPT_APPEND.md` |
| `product` | `.tlh/agents/builtin/PRODUCT_PROMPT_APPEND.md` |
| `bug-hunter` | `.tlh/agents/builtin/BUG-HUNTER_PROMPT_APPEND.md` |
| `developer` | `.tlh/agents/builtin/DEVELOPER_PROMPT_APPEND.md` |
| `test-runner` | `.tlh/agents/builtin/TEST-RUNNER_PROMPT_APPEND.md` |
| `code-reviewer` | `.tlh/agents/builtin/CODE-REVIEWER_PROMPT_APPEND.md` |
| `repo-scout` | `.tlh/agents/builtin/REPO-SCOUT_PROMPT_APPEND.md` |
| `diff-summarizer` | `.tlh/agents/builtin/DIFF-SUMMARIZER_PROMPT_APPEND.md` |
| `librarian` | `.tlh/agents/builtin/LIBRARIAN_PROMPT_APPEND.md` |
| `web-scout` | `.tlh/agents/builtin/WEB-SCOUT_PROMPT_APPEND.md` |
| `oracle` | `.tlh/agents/builtin/ORACLE_PROMPT_APPEND.md` |
| `contrarian` | `.tlh/agents/builtin/CONTRARIAN_PROMPT_APPEND.md` |

The builtin append convention searches upward to the Git worktree root and chooses the nearest exact file for each role; outside Git it checks only the current cwd. It is non-recursive, trust-gated, and separate from the direct Git-root-only custom-agent directory described in [One supported location and exact name mapping](#one-supported-location-and-exact-name-mapping).

## One supported location and exact name mapping

TLH reads custom embedded agents only from this exact location at the **validated Git worktree root**:

```text
<git-worktree-root>/.tlh/agents/custom/<UPPERCASE-SLUG>.md
```

For example, this definition:

```text
/repositories/example/.tlh/agents/custom/REPO-HELPER.md
```

is exposed as `embedded.repo-helper` and must contain `name: repo-helper` in its frontmatter. The filename is authoritative: TLH lowercases the uppercase filename stem to derive the runtime slug, then requires the frontmatter `name` to match that lowercase slug exactly.

The filename convention is strict:

- The stem must contain only uppercase ASCII letters, digits, and hyphens, and must begin with an uppercase letter or digit.
- The extension must be exactly lowercase `.md`.
- The file must be directly inside `.tlh/agents/custom`; nested directories are not searched.
- `.tlh`, `agents`, and `custom` are exact path components. Lowercase/case variants of a filename or directory are not alternate spellings.
- A cwd inside the worktree uses that worktree's root custom directory. There is no nearest-upward custom-directory search and no fallback to another root.

A cwd outside a validated Git worktree has no project custom agents, even if it contains a `.tlh/agents/custom` directory. A malformed or unreadable `.git` marker also fails closed rather than widening the search to an outer directory. Symlinked cwd paths are resolved to their physical worktree before the root is selected.

## Definition and frontmatter

The required frontmatter is:

```md
---
name: repo-helper
package: embedded
description: Trusted read-only helper for focused repository inspection
tools: read, grep, find, ls, contact_supervisor
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---
Inspect the repository and report concise findings.
```

`package: embedded`, the exact lowercase `name`, a non-empty `description`, and an explicit usable `tools` list are required. The runtime name is `embedded.<name>`; only lowercase letters, digits, and hyphens are accepted in the slug. Legacy `defaultContext` frontmatter is rejected with an actionable discovery diagnostic; remove that field because all TLH child sessions are fresh.

After the required fields, project custom definitions may declare the optional child-agent fields `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `acceptanceRole`, `skill`/`skills`, `output`, `defaultReads`, `defaultProgress`, `interactive`, `maxSubagentDepth`, `completionGuard`, `supervisorBridge`, `maxExecutionTimeMs`, and `toolBudget`. These optional fields use existing child-runtime semantics; see the [first-party dispatch reference](subagents.md) for related dispatch, tool, skill, and lifecycle behavior. Set `supervisorBridge: false` to suppress generic native-supervisor guidance and runtime `contact_supervisor` support; TLH emits `--exclude-tools contact_supervisor` without rewriting the declared `tools` field, while omitting `contact_supervisor` from runtime-required allowlist additions. Omitted fields use the runtime's ordinary agent defaults; TLH does not fill them from settings/default overrides. The custom-agent `maxExecutionTimeMs` is definition-owned: omission uses the **14400000 ms (4h)** custom fallback, while a declared positive safe integer becomes that agent's ceiling and is captured with the trusted project definition. For example:

```yaml
maxExecutionTimeMs: 1800000
```

Unsupported YAML shapes and unknown fields are not a way to extend this contract.

`tools` must be explicit and contain at least one usable entry. Named entries become the explicit tool policy; `bash`, `write`, and `edit` are valid entries and are not stripped merely because the definition is project-controlled. For example, a trusted developer-like agent may declare:

```yaml
tools: read, write, edit, grep, find, ls, bash, contact_supervisor
```

Use the smallest allowlist that fits the job. This extension point is trusted rather than sandboxed, so a `bash` or `write` grant is consequential.

`acceptanceRole` accepts only `read-only` or `writer`; custom-agent `maxExecutionTimeMs` accepts a positive safe integer (not `false`); and `toolBudget` is optional, but when present it accepts a JSON object with a required integer `hard` value of at least `1`, an optional integer `soft` value from `1` through `hard`, and an optional `block` of `"*"` or a non-empty array of non-empty tool names. Invalid values in `acceptanceRole`, `maxExecutionTimeMs`, or `toolBudget` reject the **entire definition** during discovery; they are not ignored or partially applied. Omit these optional keys when their defaults are wanted (an empty `maxExecutionTimeMs` or `toolBudget` is treated as omitted by the runtime, while an empty `acceptanceRole` is invalid). An omitted custom-agent execution limit therefore resolves to the 14400000 ms (4h) fallback.

Project custom definitions **must not declare** `extensions` or `subagentOnlyExtensions`. Either field rejects the definition, including an empty field; project-root custom agents cannot register an extension surface. Package/extra and legacy definitions are outside this inventory and cannot authorize, replace, or shadow the exact root file.

### No settings or default overrides except deny-only disable

A project custom definition is not completed or modified by settings. TLH does not apply any of these to it:

- `subagents.defaultModel` from the active profile or project settings;
- model, effort, prompt, tool, or other fields in active-profile `subagents.agentOverrides`;
- every project-setting default or `subagents.agentOverrides` field;
- other profile/default agent overrides or configured agent-directory precedence.

The one profile-local safety exception is an exact active-profile entry such as `subagents.agentOverrides["embedded.<slug>"].disabled: true`. It creates a deny-only tombstone for that captured project target; it never modifies the project agent or creates a replacement. `disabled: false` and all other fields are inert for project targets. A project-settings `disabled` entry is also inert. Removing the root definition remains the repository-owned way to remove it.

Declare the desired configuration in the root file. An explicit model, output, or other option supplied on the individual `subagent` dispatch is still a caller control; this rule prevents settings/default data from substituting for the authorized file. One live-provider exception preserves TLH's primary-agent behavior: when the current session provider is OpenRouter and the caller omits `model`, TLH injects the current `openrouter/<session-model-id>` for an embedded target, overriding that file's `model`. Other providers leave the file's `model` effective unless the caller explicitly supplies one, and an explicit caller model wins on OpenRouter too.

## Sources removed by the hard cutover

The hard cutover removes generic custom-agent discovery from TLH, not merely the ability of those sources to authorize `embedded.*` targets. Definitions from these sources no longer appear in TLH's custom-agent `list`/`get` output or direct-dispatch inventory:

- active-profile definitions under `<agent-dir>/agents/**` (including the default `~/.the-last-harness/agent/agents/` location);
- global `~/.agents` definitions;
- project `.pi/agents/**` or `.agents/**` definitions;
- paths listed in `subagents.agentDirs`;
- definitions supplied by installed packages or other extra directories.

Settings/default overrides likewise cannot create, authorize, or replace a custom target; an override that merely names `embedded.<slug>` does not add it to discovery. The explicit exception is the canonical installer-managed packaged TLH roles: their definitions continue loading from fixed `<agent-dir>/tlh/agents/subagents/<role>.md` paths and are not restored through generic discovery or `subagents.agentDirs`.

`.pi/skills`, `.agents/skills`, and other supported skill sources are separate features; removing these custom-agent sources does not remove skill discovery. The canonical copied TLH minor prompts under `<agent-dir>/tlh/agents/subagents/` remain first-party packaged resources, not user custom agents.

This is a hard cutover. Existing profile definitions are not automatically copied, renamed, or deleted, and the old sources are not fallback authorizers. Keep a backup, migrate any definition you still need to the exact root layout in [One supported location and exact name mapping](#one-supported-location-and-exact-name-mapping), and then remove or archive the obsolete copy and stale settings at your convenience.

## Trust and safe reads

A project custom file is executable only after TLH finds a **persisted** positive project-trust decision covering the validated Git root. In the TLH TUI, run `/trust` from the repository root (or another path whose persisted decision covers that root), choose the persistent `Trust` option, save it, and retry. A session-only decision is not authorization, and a decision saved only for a nested cwd does not authorize the root custom directory. No custom-file content is used while trust is missing, denied, or unreadable.

Project model/effort defaults in [the model guide](models.md#project-modeleffort-defaults) use a separate, weaker configuration-trust decision. That decision applies packaged defaults only; it never authorizes or modifies these project custom agents, which always require persisted positive project trust.

Every custom definition is read with the same fail-closed limits used for project-agent authorization:

- maximum **64 KiB (65,536 UTF-8 bytes)**;
- a regular, non-symlink file only;
- real `.tlh`, `agents`, and `custom` directories, with no symlink at any intermediate component;
- canonical containment beneath the validated Git root and direct custom directory;
- stable file identity checked between discovery, authorization, and execution.

A file that is oversized, replaced, swapped, non-regular, symlinked, malformed, or outside the validated root is rejected. TLH never follows a symlink, truncates an oversized definition, or falls through to a different same-name source.

## Who may initiate and how scope is forced

Only `architect` and `disabled` may **initiate** a new `embedded.<slug>` execution. The user-facing primary prompt asks the active primary to use a trusted custom agent only when the user explicitly names or requests it; that is prompt policy, not a substitute for the runtime authorization gate.

- `product` and `bug-hunter` cannot initiate embedded custom delegation. Their opaque controls remain available only for eligible non-project runs; they cannot control a retained or persisted project-agent run.
- `rush` cannot initiate embedded delegation, cannot use opaque `resume` or `steer`, and cannot delegate implementation to `developer`; it must edit directly for implementation work.
- Only `architect` may `resume` or `steer` a retained or persisted project-agent run. These project-agent controls are blocked for every other primary, including `disabled`; `disabled` may initiate a freshly scoped, user-requested project custom run but cannot resume or steer a retained or persisted project-agent run.

For an execution containing an embedded target, TLH forces `agentScope: "project"`; `agentScope: "user"` is rejected. Every child dispatch—canonical or embedded, single or parallel, foreground or asynchronous—starts a new session and never inherits the primary session transcript. A mixed batch containing canonical TLH roles and an embedded target is therefore resolved in project scope, but the canonical packaged roles remain available. Every embedded target in one dispatch must resolve to the same validated Git root, and a task-level `cwd` override must remain inside that root. A cwd override cannot select a second repository or turn an outside-Git directory into an authorized custom source.

The runtime captures the exact authorized path and filesystem identity in the project snapshot, then checks that snapshot capability again before a foreground, parallel, or asynchronous child starts. A missing or changed capability fails closed with an actionable project-agent authorization error rather than silently selecting a same-name profile or package definition.

## Invocation, reload, and process timing

Ask for the exact runtime name:

```text
Use embedded.repo-helper to inspect the authentication flow.
```

The project custom-agent inventory is captured at session start or `/reload` as an immutable project snapshot. For new embedded executions in the same process, adding, editing, moving, or deleting the root file takes effect only after `/reload` or a new session; it does not change the active generation or a live child. Changing persisted project trust is different: same-process `resume` and `steer` reauthorize current persisted project trust before acting, so revoking persisted project trust blocks those controls even though it does not mutate a live child. A process-restarted resume/revival is a separate operation that independently revalidates the current root file and trust under the checks in the table below. `/reload` remains useful for ordinary TLH resources and for starting a new primary/minor prompt snapshot.

The timing boundaries are intentionally different for each surface:

| Surface | When the file is read | What changes an existing run sees |
| --- | --- | --- |
| Primary role append | At primary session start; all thirteen role candidates share one inventory snapshot, and switching primary roles selects from that snapshot | Edits or newly persisted trust take effect after `/reload`/new session, not in the current primary snapshot |
| Minor role append | When each child process starts, for foreground, parallel, async, and any resume/revival that starts a new process | A live async `resume`/`steer` that keeps the same child process keeps its session-start append snapshot; a new process reads current content |
| Project custom definition | At project snapshot capture and through the private snapshot capability when a child starts | A live child and same-process resume keep the captured configuration, but same-process `resume`/`steer` reauthorize current persisted project trust; a process-restarted resume/revival revalidates the current trusted root file and reads current configuration, while a resume from a genuine new session fails closed |

The primary snapshot is used only for the active packaged primary role; `disabled` receives no primary-role append. A minor append is added only to its matching canonical packaged TLH minor role. A custom agent's own Markdown prompt is its child configuration and is not a role append.

## Migrate from an older profile definition

For each old profile custom definition you want to retain:

1. Copy its prompt body and supported frontmatter into `<git-worktree-root>/.tlh/agents/custom/`.
2. Rename the file to the exact uppercase form, for example `repo-helper.md` → `REPO-HELPER.md`.
3. Set `package: embedded`, set `name: repo-helper` to match the lowercase filename stem, and provide a non-empty `description`.
4. Remove `defaultContext` (TLH now always starts child sessions fresh) and remove `extensions` and `subagentOnlyExtensions`; put any required tool grants explicitly in `tools` (including `bash`, `write`, or `edit` only when genuinely needed).
5. Persist project trust for the Git root, then invoke `embedded.repo-helper` from `architect` or `disabled` mode.
6. After checking the migrated definition, remove or archive the old profile/global/project copy and clean up any obsolete `subagents.agentDirs` or embedded settings entries. TLH does not perform that deletion for you.

For settings migration, remove legacy `defaultContext` from custom frontmatter and from any old `subagents.agentOverrides` entry. Caller-supplied `context` and `turnBudget` (including `maxTurns` and `graceTurns`) were dispatch/runtime inputs, not settings override fields; omit them from new dispatches rather than treating them as settings to migrate. The removed external pi-intercom detach request/result/control integration used the on-disk extension config key `intercomBridge` in `<agent-dir>/extensions/subagent/config.json`; install/update preserves user-owned stale config, so you may remove that key manually. TLH does not rewrite settings or extension config. Keep supported controls in the migrated definition, such as `toolBudget` and a positive-safe-integer `maxExecutionTimeMs`; do not add a model-facing root `timeoutMs` or public `tasks[].timeoutMs`; callers sending either are rejected before launch. An executable async-runner envelope/config with its own root `timeoutMs`, or a persisted plan with plan-root `timeoutMs`, fails closed before launch; remove only that retired envelope/plan-root field and restart as a new direct single or parallel run. TLH-written per-step `plan.task.timeoutMs` and `plan.tasks[].timeoutMs` values remain valid trusted role-ceiling metadata and must not be removed. Historical records remain readable and are not rewritten. Configure a shared deadline through `execution.maxRunTimeMs` in `<agent-dir>/extensions/subagent/config.json` instead. Removing a custom agent's `maxExecutionTimeMs` frontmatter restores the 14400000 ms (4h) fallback; setting `false` is reserved for the human-owned shared config or canonical-role settings override and clears only that layer. Existing `.chain.md`/`.chain.json` files and other legacy artifacts are left untouched rather than imported, rewritten, or deleted.

The same hard cutover applies to the old builtin append convention `.tlh/<ROLE>.md`: it is never read as a fallback. Move its body to the corresponding exact `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` file described in the README, then persist trust and reload/restart as appropriate.

## Undo or temporarily disable

To revoke a project custom agent, remove or move its exact root file out of `.tlh/agents/custom`:

```sh
rm -f .tlh/agents/custom/REPO-HELPER.md
```

The next authorization or new-process resume fails closed. Removing the file does not rewrite settings or alter an already-running child; interrupt or stop that run with the normal subagent controls. To temporarily disable an agent without deleting it, move it to a reviewed backup location outside the exact custom directory. Restore it with the same uppercase filename and valid frontmatter when it should become eligible again.

To undo a builtin append, remove its exact `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` file and run `/reload` or restart. An ancestor append may still be the nearest match; remove that file too if you want no append, or leave an empty nearest file to intentionally shadow farther guidance. The removed legacy `.tlh/<ROLE>.md` path never becomes active again.

## `APPEND_SYSTEM.md` is different

The upstream global/project `APPEND_SYSTEM.md` mechanism appends **general system instructions**. In a default TLH install, the global file is `<agent-dir>/APPEND_SYSTEM.md` (normally `~/.the-last-harness/agent/APPEND_SYSTEM.md`) and the project file is `.pi/APPEND_SYSTEM.md` when the project is trusted. Those files do not authorize custom agents and do not select a role.

Conversely, `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` is an append for one of the thirteen packaged TLH roles only. It does not replace or reconfigure the packaged system prompt. A project custom definition at `.tlh/agents/custom/<UPPERCASE-SLUG>.md` is a separate child-agent definition and must satisfy its own exact-path, trust, frontmatter, and snapshot-capability checks.

## Diagnostics and safety reminders

`/subagents-doctor` and `subagent({ action: "doctor" })` provide general runtime/discovery diagnostics. `tlh doctor` checks installer-owned profile resources; it does not grant project trust or replace the exact-root custom-agent authorization checks. If a request is blocked, check the cwd's validated Git root, exact uppercase filename, lowercase frontmatter name, `package: embedded`, non-empty description, persisted trust, regular-file/symlink status, 64 KiB limit, and the absence of rejected extension fields.

Treat every project custom agent as trusted code supplied by the repository owner. Do not use this feature as a safe way to execute prompts from an untrusted checkout.
