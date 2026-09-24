# First-party subagents

Subagent orchestration is part of TLH itself. The runtime entrypoint ships at `extensions/subagents/src/extension/index.js`, the bundled agent definitions ship under `agents/subagents/`, and the TLH package declares the runtime in `package.json` under `pi.extensions`. There is no separate subagent package to install, pin, publish, or update for TLH.

Most users should delegate in natural language to the active primary agent. The architect chooses the appropriate bundled agent, supervises the run, and judges the result. Implementation tickets go to `developer`, while a separate final-validation ticket with explicit ordered shell/MCP steps goes to the execution-only `test-runner`; the latter reports results without editing, installing dependencies, fixing failures, or changing tickets. The runtime details below are mainly useful when diagnosing a run or developing TLH.

## Isolation and discovery

The managed wrapper sets `PI_CODING_AGENT_DIR` to the isolated TLH profile before the upstream Pi runtime starts. Subagent settings, copied agent definitions, child sessions, and runtime state therefore stay under that active profile instead of normal `~/.pi/agent`. Child processes resolve the same private Pi runtime as their parent; an unusable resolved runtime fails clearly instead of silently falling back to an ambient global `pi`.

TLH copies its nine canonical minor-agent definitions to `<agent-dir>/tlh/agents/subagents/<role>.md` and loads them through that installer-managed path. No `subagents.agentDirs` default is installed or required for these first-party roles. Primary-agent delegation resolves ordinary targets with the requested/default `agentScope`; embedded targets are loaded independently from their fixed project files and do not alter that scope. Every child starts a fresh session and never inherits the primary session transcript. This prevents unrelated project, package, legacy-profile, or extra-directory definitions from shadowing them and prevents the parent's primary-agent or Gnosis context from leaking into a child.

The canonical packaged TLH roles are thirteen roles: the four primaries `architect`, `rush`, `product`, and `bug-hunter`, plus nine bundled minors — `developer` for implementation, `test-runner` for exact final-validation shell/MCP steps, `code-reviewer`, `repo-scout`, `diff-summarizer`, `librarian`, `web-scout`, `oracle`, and `contrarian`. The built-in definitions that shipped with the upstream runtime have been removed outright. Stable, always-available project custom `embedded.<slug>` agents are a separate exact-root contract available to the architect or disabled primary mode; see [custom-subagents.md](custom-subagents.md).

### Malformed custom-agent handling

A malformed custom markdown definition is isolated during discovery instead of aborting the whole agent set. Definitions that fail validation (for example, missing required frontmatter or invalid package or execution-limit values) are skipped while valid peers remain executable. `subagent({ action: "list" })` reports an **Agent load warnings** section with the source path and validation error; requesting a skipped definition reports the same diagnostic when it can identify the file. Tolerated legacy `completionGuard` keys are not load failures: they are ignored and, for canonical profile definitions/settings, appear separately as **Agent migration notices** in the doctor output.

### Project custom embedded agents

Project custom embedded agents are read only from the direct path `<validated-git-root>/.tlh/agents/custom/<UPPERCASE-SLUG>.md`. The uppercase filename stem is authoritative and must map to the exact lowercase frontmatter `name`; `package: embedded` and a non-empty `description` are required. Persisted project trust must cover the Git root. No recursion, case-variant path, symlink, non-regular file, or definition larger than 64 KiB is accepted, and `extensions`/`subagentOnlyExtensions` are rejected. An explicit usable `tools` list is required; entries—including `bash`, `write`, and `edit`—remain supported. The file is self-contained: project defaults and model/agent overrides do not replace or complete it. A TLH-primary OpenRouter dispatch injects the live session model when the caller omits `model` (see [custom-subagents.md](custom-subagents.md)). TLH removes generic custom-agent discovery from active-profile `agents/**`, global `~/.agents`, project `.pi/agents/**` and `.agents/**`, configured `subagents.agentDirs`, and installed-package/extra-directory definitions; those definitions cannot authorize an `embedded.<slug>` target.

Only `architect` and `disabled` may initiate a custom embedded run. Every child starts a fresh session. Mixed calls discover ordinary targets using the caller's requested/default `agentScope`; each embedded target is independently resolved from its fixed file, and every requested cwd must remain inside that target's canonical Git root. If one embedded slug resolves to different canonical roots or definition files within one dispatch, TLH rejects the dispatch before spawning. Durable status stores only the project identity `{ slug, root, cwd }`, never a prompt or configuration snapshot. Dispatch, resume, steer, and interrupt re-resolve the fixed file and persisted trust, so edits, removal, symlink replacement, or trust revocation fail closed on the next operation. The canonical installer-managed packaged TLH roles remain available from fixed `<agent-dir>/tlh/agents/subagents/<role>.md` paths, outside generic discovery or `subagents.agentDirs`. See [custom-subagents.md](custom-subagents.md) for the full primary restrictions, migration, and undo procedure.

## Dispatch and tool surface

The model-facing `subagent` tool deliberately has a small, fail-closed surface:

- **Single:** one `agent`, optional `task`, and optional `ticket` ID.
- **Parallel:** a `tasks` array. Each task accepts `agent`, `task`, optional `ticket` ID, `cwd`, `count`, `output`, `outputMode`, and `model`; parallel limits are configured in `<agent-dir>/extensions/subagent/config.json`.
- **Ticket context:** when `ticket` is present, TLH trims and validates the ID, runs `tk show <id>` without a shell in the effective task cwd, and fails before spawning if the lookup fails. The exact stdout is appended to the initial child prompt under `## Ticket <id>`. Status and result artifacts persist only the per-child `ticketId`; ticket bodies are not copied into notifications or result metadata.
- **Synchronous by default:** the parent awaits the run and receives the terminal child result. Ordinary single/parallel calls use the same TLH-tracked runner as detached work; this describes tool-call behavior, not a separate execution engine.
- **Asynchronous when requested:** `async: true` keeps the detached behavior: it starts TLH-tracked background work in a detached OS child process managed by TLH and returns an ID and runtime directory so the parent can continue useful work.
- **Execution controls:** `cwd` and `artifacts`; single runs also accept `output`, `outputMode`, and `model`. Agent definitions own `defaultReads`, `defaultProgress`, and `fallbackModels`; every execution starts a fresh child session. Execution is action-free for single/parallel runs; legacy `action: "single"`, `action: "parallel"`, `action: "tasks"`, and `maxRuntimeMs` inputs are not accepted. Execution deadlines are human-owned: models and callers cannot provide a model-facing root `timeoutMs` or public `tasks[].timeoutMs`.

`single` and `parallel` are the only execution forms; each uses the same TLH-tracked runner, either as the default awaited tool call or as a TLH-tracked detached async run. This is a fresh-only contract: `context` is not an execution input, `defaultContext` is not a supported definition or settings field, and no parent transcript is inherited. A child receives its task and explicitly configured definition; project-instruction and skill settings remain explicit child configuration, not transcript inheritance. Persisted direct plans containing the retired `structuredOutput` or `structuredOutputSchema` task properties fail closed before a child launches; remove those properties and start a new direct single or parallel run. An executable async-runner envelope/config with its own root `timeoutMs`, or a persisted plan with plan-root `timeoutMs`, also fails closed before launch. By contrast, TLH-written per-step `plan.task.timeoutMs` and `plan.tasks[].timeoutMs` values are trusted role-ceiling metadata and remain valid; do not remove them. Historical records remain readable and are not rewritten. `async: true` is TLH's internal tracked background runner, using the detached OS child process described above; it is not the removed external pi-intercom detach request/result/control integration or a separate control-channel API.

An agent's `maxExecutionTimeMs` is a hard per-child upper bound; the human-owned run-level policy and role ceiling are enforced together. There is no `turnBudget` or turn-count control in the reduced contract.

### Timeout ownership and execution ceilings

Execution time has two human-visible layers, and neither is a model-facing tool parameter. The shared run-level policy is stored in the human-owned config file `<agent-dir>/extensions/subagent/config.json` (normally `~/.the-last-harness/agent/extensions/subagent/config.json`):

```json
{
  "execution": {
    "maxRunTimeMs": 14400000
  }
}
```

An absent `execution.maxRunTimeMs` uses the bounded default of **14400000 ms (4h)**. It must be a positive safe integer or the explicit boolean `false`. An invalid value is warned about and safely falls back to 14400000 ms. Install and update preserve this human-owned block and unrelated config keys. The execution policy is resolved when the subagent extension loads (normally at session start), not at each dispatch; reload the extension or restart `tlh` after editing the file. A run already underway retains the policy it resolved at startup.

The code-owned ceilings for the nine canonical minor roles are:

| Role | `maxExecutionTimeMs` |
| --- | ---: |
| `developer` | 3600000 ms (1h) |
| `code-reviewer` | 1800000 ms (30m) |
| `test-runner` | 3600000 ms (1h) |
| `librarian` | 14400000 ms (4h) |
| `oracle` | 2700000 ms (45m) |
| `contrarian` | 1800000 ms (30m) |
| `repo-scout` | 600000 ms (10m) |
| `web-scout` | 300000 ms (5m) |
| `diff-summarizer` | 300000 ms (5m) |

TLH applies those code-owned role defaults before resolving human overrides. For a canonical role whose definition does not explicitly declare the field, TLH selects one `subagents.agentOverrides.<role>` object: the selected project's entry when present, otherwise the active isolated profile's entry from `<agent-dir>/settings.json`. The two objects are not merged field-by-field. Therefore, a project entry that omits `maxExecutionTimeMs` does not retain a profile value; absent an authoritative frontmatter value, the code-owned role default remains. The selected human override accepts a positive safe integer or `false`. An explicit `maxExecutionTimeMs` in a packaged role's frontmatter is definition-owned and remains authoritative for that field. A trusted project custom agent may set a positive safe integer in its own frontmatter; if it omits the field, its custom-agent fallback is **14400000 ms (4h)**. Project custom agents are self-contained and are not completed or overridden by profile/project `subagents.agentOverrides` settings.

`false` has deliberately narrow scope. Setting `execution.maxRunTimeMs` to `false` removes only the shared run-level ceiling; setting `subagents.agentOverrides.<role>.maxExecutionTimeMs` to `false` clears only that canonical role's ceiling. A custom-agent frontmatter value of `false` is invalid; omit the field for the 4-hour custom fallback. In every case, another applicable run or role bound may still constrain execution, including a definition-owned role ceiling, provider/network or control handling, or an external supervisor.

A direct single run has one shared run deadline. A parallel batch has one shared overall deadline, not one budget per task: it covers queueing and concurrency wait, child startup, fallback/retry work, and the rest of that direct batch in both awaited and async modes. Role ceilings remain independent per child and are not divided among siblings. The old caller-selected six-minute scout exception tracked by issue #420 is retired; the role values above are the current policy.

Every child spawn receives a fresh wall-clock role deadline anchored at that spawn. A model fallback/retry and a paused-run resume therefore receive a complete new role ceiling; earlier child runtime, pause duration, and historical ledger values do not reduce it. The shared `maxRunTimeMs` deadline still covers the whole direct single or parallel batch, including queueing, fallback work, and resumed work when that run-level bound applies. Role ceilings remain independent per child and are not divided among parallel siblings. Running status duration is measured from the current child spawn. Historical `activeRuntimeMs` and checkpoint fields may remain in old status/result artifacts for compatibility, but TLH ignores them and does not write new ledger fields.

Timeout markers follow the same ownership boundary: a role-ceiling timeout sets `timedOut` on the affected child step/result, while a shared `maxRunTimeMs` timeout sets `timedOut` on the top-level run status/result and marks unfinished children. A run can therefore finish in `failed` state because one role timed out without its top-level `timedOut` marker being set; inspect the per-child marker and `terminationReason` to identify that case.

This policy covers execution ownership only. Do not migrate unrelated timeout fields into it: provider/network timeouts, control and supervisor limits, and timeout metadata used by status, artifacts, or historical readers remain separate. Historical files are readable as-is and are not rewritten.

### Migration and rollback

A direct caller that sends model-facing root `timeoutMs` or public `tasks[].timeoutMs` is rejected before launch with migration guidance. Separately, an executable async-runner envelope/config with its own root `timeoutMs`, or a persisted plan with plan-root `timeoutMs`, fails closed before child launch; remove only that retired envelope/plan-root field and restart as a new direct single or parallel run. TLH-written per-step `plan.task.timeoutMs` and `plan.tasks[].timeoutMs` values remain valid trusted role-ceiling metadata and must not be removed. Historical records remain readable and are not rewritten. There is no compatibility switch that restores the retired public caller behavior; rolling back the package version is the only way to do that, subject to the normal isolated-profile safety guidance.

The completion guard and task-intent mutation heuristics are retired. Legacy `completionGuard` frontmatter and `subagents.agentOverrides` keys are tolerated as unknown fields and ignored at runtime. `subagent({ action: "doctor" })` reports obsolete keys found in settings and canonical packaged-agent discovery, plus the read-only persisted trust state for the request cwd's validated Git root; it does not read embedded project-agent definitions. `tlh doctor` is the installer/profile health check and does not scan project embedded agents. Remove legacy keys manually when convenient. Apart from explicitly documented retired-key scrubs, including `toolBudget` and prior retired keys, TLH does not rewrite unrelated user configuration. Legacy frontmatter unknowns are tolerated and ignored.

To restore the bounded shared default, remove `execution.maxRunTimeMs` from the isolated extension config and reload/restart. To undo an explicit unbounded choice, replace `false` with a positive value or remove the key. To restore a canonical role's code-owned ceiling, remove its `maxExecutionTimeMs` entry from the applicable `subagents.agentOverrides.<role>` object; removing a custom agent's frontmatter field restores its 14400000 ms fallback. Preserve a backup before editing, keep unknown settings keys, and never edit the normal `~/.pi/agent` profile.

Thinking suffixes are forwarded with the selected model argument; TLH does not consult registry capability metadata or silently drop a requested level. If Pi rejects an invalid model argument, that is a non-transient child failure and is surfaced without model fallback.

### Child tool-policy translation

The optional `tools` declaration has three distinct states, and the child CLI is enforced accordingly:

- **Omitted:** no tool restriction flag is passed, so Pi's existing builtin and extension defaults remain available.
- **Explicit empty or MCP-only:** all tools are disabled with `--no-tools`, except that runtime-required tools are added to an exact allowlist: `read` for lazy skills and `contact_supervisor` for an active supervisor bridge. Entries are deduplicated in stable order.
- **Named tools:** named entries become an exact `--tools` allowlist; extension paths are registered separately. A declaration containing only extension paths uses `--no-builtin-tools`, leaving those custom tools and runtime extension tools available.

An agent may declare `supervisorBridge: false` to opt out of generic native-supervisor prompt guidance and runtime `contact_supervisor` support. TLH emits `--exclude-tools contact_supervisor`; it does not rewrite the declared `tools` field, and `contact_supervisor` is omitted only from the runtime-required allowlist additions.

A path-only declaration cannot be combined with lazy skills because Pi cannot express a securely named `read` tool alongside unknown extension registrations. Such a definition fails early with guidance to list each extension tool name (TLH injects `read` automatically). MCP entries in the declaration are not registered as direct child tools; the child MCP sentinel keeps direct MCP bootstrap disabled.

The supported actions are `list`, `get`, `status`, `interrupt`, `resume`, `steer`, and `doctor`. Saved chains and chain dispatch are intentionally not part of the current TLH contract. TLH does not execute, rewrite, or delete saved-chain artifacts; existing `.chain.md` and `.chain.json` files are left untouched. Mutating agent-management actions such as create/delete/reset are also not exposed through the model-facing schema; project custom agents remain Markdown files managed at the exact Git-root path documented in [custom-subagents.md](custom-subagents.md). Project custom subagents are intentionally omitted from management `list`/`get` results.

Keep one writer per working directory. Parallel developers writing the same checkout can race even though their session contexts are isolated; use parallelism for read-only discovery/review or independent workspaces, and keep one owner for edits.

### Explicit ticket context

Pass a ticket ID through the model-facing `ticket` parameter rather than embedding `tk show <id>` in task prose. For a single run, use the top-level `ticket`; for parallel work, assign `ticket` independently on each task. TLH trims and validates each ID against a safe letters/numbers/hyphens grammar, runs `tk show <id>` with argv (never a shell) in that child’s effective cwd, and fails the whole dispatch before spawning if any lookup fails or `tk` is unavailable.

The exact stdout body is appended only to that child’s initial prompt under `## Ticket <id>`. Persisted status and result artifacts carry only the child’s normalized `ticketId`; ticket bodies stay out of status text, notifications, and result metadata. A resumed or replacement child may carry the persisted ID without re-reading or copying the original body; its existing session remains the source of the earlier prompt context. Child role prompts should treat an injected ticket body as the source of truth and may run `tk show <id>` only to re-read it.

After each successful compaction, a pinned canonical developer receives exactly one visible scope reminder to re-run `tk show <id>`, reread the ticket acceptance criteria, and remain within scope. For overflow retries, TLH queues that custom message with Pi's `steer` delivery mode so it is present before the guaranteed retry; for non-retry compaction, it uses Pi's `nextTurn` delivery so the pending message is included with the next real prompt without creating an extra assistant turn. `session_compact_failed` events never inject it. Other agents and unpinned developer sessions receive no reminder, and Pi's default summary generation remains unchanged.

### Final-validation test-runner

The packaged `test-runner` declares `tools: bash, mcp` and `supervisorBridge: false`. It can use the generic MCP gateway to discover, connect to, and invoke any configured server/tool, including tools that change server-side state, but direct `mcp:*` tools remain disabled by the `MCP_DIRECT_TOOLS=__none__` sentinel and the frontmatter allowlist. A final-validation ticket must provide an exact ordered list of shell commands and/or MCP calls. Each MCP step is exact adapter-shaped gateway input with only the fields required by the selected status, discovery, search, connect, or call operation; `server`, `tool`, and JSON-string `args` are optional overall. The runner treats the injected ticket body as the source of truth and may run `tk show <id>` only to re-read it; it does not infer or broaden steps from prose. It stops after the first failed shell/MCP step and may not edit the repository, install or fix anything, mutate shell/package/ticket state, delegate, or call `contact_supervisor`.

## Skills

Skills are named instruction sets injected into a child subagent's system prompt before a run begins. They let you package reusable workflows, coding conventions, or operational runbooks as separate files and attach them to specific agents without hardcoding the text in every agent definition.

### Declaring skills on an agent

Add `skill:` or `skills:` to the agent's YAML frontmatter (either key is accepted; they are read as `frontmatter.skill || frontmatter.skills`):

```yaml
---
name: developer
skill: tlh-dev-hygiene
---
```

Multiple skills are comma-separated:

```yaml
skill: tlh-dev-hygiene, python-style
```

There is no `skill` or `skills` parameter on the model-facing `subagent` tool. Skills are configured exclusively through agent frontmatter (or through settings-based overrides described below).

For built-in agents, an entry keyed by the agent's plain name under `subagents.agentOverrides` in `settings.json` also accepts `skills` as a string array, or `false` to disable skills for that agent. The frontmatter value normally takes precedence over the override when both define a field:

```json
{
  "subagents": {
    "agentOverrides": {
      "developer": {
        "skills": ["tlh-dev-hygiene"]
      }
    }
  }
}
```

In config overrides, `"tools": false` clears the override so the agent inherits its normal tool behavior, while `"tools": []` is an explicit no-tools policy.

Set `"skills": false` in the override to disable skills for agents whose frontmatter does NOT declare `skill:` or `skills:`; when the frontmatter declares them, the override is ignored entirely.

### Resolution sources and search order

When a run starts, the runtime walks the following locations and collects all skill directories (each containing a `SKILL.md` file, whose parent directory name becomes the skill name). When the same name appears in multiple locations, the source with the **highest priority number wins**. This ordering is defined by `SOURCE_PRIORITY` in `skills.ts` and assembled by `buildSkillPaths`.

| Priority | Source             | Typical path                                                                                                  |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 700      | `project`          | `.pi/skills/` or `.agents/skills/` in the project root                                                        |
| 650      | `project-settings` | Paths listed under `skills` in `.pi/settings.json`                                                            |
| 600      | `project-package`  | `.pi/npm/node_modules/<pkg>` (via `pi.skills` in `package.json`) or project root `package.json` → `pi.skills` |
| 300      | `user`             | `<agent-dir>/skills/`                                                                                         |
| 250      | `user-settings`    | Paths listed under `skills` in `<agent-dir>/settings.json`                                                    |
| 200      | `user-package`     | `<agent-dir>/npm/node_modules/<pkg>` or the global npm root                                                   |
| 180      | `project-claude`   | `.claude/skills/` in the project root ²                                                                       |
| 170      | `user-claude`      | `~/.claude/skills/` ²                                                                                         |
| 150      | `extension`        | Not assigned by `buildSkillPaths` or `inferSkillSource`; only reachable via an explicit `sourceHint` ¹        |
| 100      | `builtin`          | Not assigned by `buildSkillPaths` or `inferSkillSource`; only reachable via an explicit `sourceHint` ¹        |
| 0        | `unknown`          | Anything that does not match a known root                                                                     |

¹ `extension` and `builtin` are defined in `SOURCE_PRIORITY` and appear in the doctor's per-source breakdown, but `buildSkillPaths` never emits them and `inferSkillSource` never infers them. No current runtime caller passes either as a `sourceHint`; they are reserved for future use.

² Both Claude-sourced roots (`project-claude` at 180 and `user-claude` at 170) rank below every non-Claude source, including user-scoped ones. This diverges from the usual project-over-user ordering for three reasons: (a) `<cwd>/.claude/skills` is repo-controlled content — a cloned repository can place skills there, and the subagent resolver applies no trust gate (unlike the primary-agent hook), so ranking it low is the mitigation; (b) `~/.claude/skills` is a directory curated for a different tool, not for tlh, so tlh’s own curated skills should win a name collision; (c) it keeps the subagent resolver consistent with the primary agent, where extension-provided paths are appended after all defaults and therefore lose every same-name collision. Within the two Claude sources, `project-claude` is intentionally above `user-claude` so that when two `.claude/skills` entries collide with each other, the project-local one wins.

Deduplication is per resolved absolute path: if the same physical directory appears via two routes, the one with the higher source priority wins.

#### Trust gating and primary-agent / subagent asymmetry

The two surfaces that discover `.claude/skills` directories behave differently:

- **Primary agent** (`resources_discover` hook in `claude-skills.ts`): project roots are gated on `ctx.isProjectTrusted()`. When the project has not been trusted, all `.claude/skills/` directories from the ancestor walk are silently skipped. The ancestor walk starts at `<cwd>` and climbs to the git root, collecting a `.claude/skills/` candidate at every level before stopping. User root (`~/.claude/skills`) is always a candidate regardless of trust.
- **Subagent resolver** (`buildSkillPaths` in `skills.ts`): only uses `<cwd>/.claude/skills` (no ancestor walk) and does **not** gate on project trust, following the same convention as the existing `.pi/.agents` roots.

To opt out of `.claude/skills` discovery entirely, set `"tlh": { "claudeSkills": { "disabled": true } }` in the isolated profile's **global** `settings.json` (`~/.the-last-harness/agent/settings.json`). The setting is read from that file only; a project-level `.pi/settings.json` has no effect on this flag.

### Two-cwd fallback

`resolveSkillsWithFallback` runs two resolution passes for each run:

1. **Task cwd** — the working directory the task runs in (the `cwd` option if provided, otherwise the runtime cwd).
2. **Runtime cwd** — the working directory of the parent extension process.

Skills not found after the first pass are retried against the runtime cwd in the second pass. If the two paths resolve to the same directory the fallback is skipped. Any skill still missing after both passes is collected into the `missing` list.

### What injection looks like

For each resolved skill, the runtime reads the `SKILL.md` file (stripping any YAML frontmatter) and appends an `<available_skills>` block to the child's system prompt via `buildSkillInjection`:

```text
The following configured skills are available to this subagent.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>tlh-dev-hygiene</name>
    <description>Pre-commit hygiene checklist for TLH contributors</description>
    <location>/path/to/.pi/skills/tlh-dev-hygiene/SKILL.md</location>
  </skill>
</available_skills>
```

The child is instructed to load the skill file on demand using the read tool, not to memorise it upfront.

### Missing-skill behavior

If a named skill is not found in any search location after both passes, it is added to the `missing` list and the run **continues**. A warning string `Skills not found: <name>, ...` is attached to the child result and persisted in async `status.json`/result artifacts; awaited live updates also expose it while the run is active. Awaited runs show the warning as a TUI warning line alongside the run output.

Exception: if `pi-subagents` is requested, the run **fails immediately** rather than continuing — see below.

### The `pi-subagents` skill

The skill named `pi-subagents` can never be injected into a child. Children have no `subagent` tool (`registerSubagentExtension` is skipped for child processes), so orchestration instructions reaching a child would be unactionable and violate the "subagents cannot spawn subagents" boundary.

Requesting `pi-subagents` as a skill **fails the run immediately** with `"Skills not found: pi-subagents"` rather than continuing with a warning. The `resolveSkills` function hardcodes this skill name to always go to the `missing` list, regardless of whether a matching file exists on disk. This is intentional — users who see this error should remove `pi-subagents` from their agent's `skill:` declaration.

### `skills` vs `inheritSkills`

These two mechanisms are distinct:

|              | `skills` (frontmatter)                                       | `inheritSkills` (frontmatter)                                   |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| What it does | Injects specific named skills into the child's system prompt | Passes the _parent's_ existing skills section down to the child |
| Default      | None (no injection)                                          | `false` (parent skills stripped by `rewriteSubagentPrompt`)     |
| Format       | Comma-separated skill names, or array in settings override   | Boolean (`true`/`false`)                                        |
| When to use  | Give an agent a specific runbook or checklist                | Let a child share the parent's ambient skill context            |

Use `skills:` when a child agent should always receive a particular skill regardless of what the parent has loaded. Use `inheritSkills: true` when the parent's skills are contextually relevant and you want the child to receive them without redeclaring them.

Both can be set on the same agent. If both are active, the child receives its own injected skills plus the parent's inherited skills section.

### Verifying discovery

Run the doctor from a project directory to confirm which skills the runtime discovers:

```
/subagents-doctor
```

The report's **Discovery** section includes a `skills:` line with the total count and a per-source breakdown, produced by `discoverAvailableSkills(cwd)`:

```text
- skills: total 3 (project 2, user 1)
```

The `pi-subagents` skill is filtered out of discovery output by design — it will not appear in the list even if a matching file exists on disk.

## Async control, pause, and resume

An asynchronous receipt includes an `asyncId` and `asyncDir`. Status and lifecycle data are persisted there, including `status.json`, `events.jsonl`, and output/log references. Use `subagent({ action: "status" })` to list active runs from the current session, or provide an `id` to inspect a specific model-facing run and its children. Add `view: "transcript"` with optional `lines: 1` through `500` to tail retained output or a canonical child session; transcript reads are limited to runs owned by the current session.

**Unreadable status files.** A status/list request, direct status lookup, or `/subagents-doctor` scan retries an unreadable, invalid, or oversized `status.json` exactly once after a short bounded delay. If it remains unreadable, the surface reports `unreadable status at <path>` and continues showing healthy runs; list and doctor output shows the first 20 paths and then a bounded count of additional failures. TLH does not automatically rename, delete, rewrite, or create directories for this condition. Manually inspect the status and its sibling artifacts before repairing or undoing a partial write; preserve a copy first and make any repair explicitly. Existing `<tempRoot>/quarantined-async-subagent-runs/` directories are no longer scanned; after preserving any needed evidence, you may remove them manually. The new runtime never auto-deletes that legacy directory.

**Stale-run reconciliation.** The runtime has one stale-run rule: if a persisted run has a non-terminal lifecycle state and its recorded runner PID is proven dead, reconciliation marks the run `failed` and clears active ownership. This includes a `pausing` run whose runner died before pause finalization. A live or unknown PID is retained rather than guessed at, and already-terminal runs are not rewritten.

The runtime distinguishes these controls:

- `steer` queues guidance to a currently live async child without first pausing it.
- `resume` with a live child is an acknowledged follow-up/nudge path; the live child is interrupted before the follow-up is delivered.
- `interrupt` is a soft, resumable interruption for active work. Applied to an already durable paused child, it cancels that continuation.
- A blocking supervisor decision pauses durably. No child process remains alive while paused; persisted lifecycle/session data is used when the parent later chooses unchanged resume, guided resume, or cancellation.

**Supervisor lifecycle finalization failure.** If TLH cannot durably finalize that pause, it marks the run `failed` and persists the internal `lifecycle.resumeBlockedReason: supervisor_lifecycle_failure`. Status shows `Resume: unavailable`; resume, cancel, and nested revival are permanently rejected for that run to avoid duplicate or unowned work. Ordinary failed runs without this marker remain revivable.

Only `needs_attention` is emitted as a current health/control state. The retired `active_long_running` marker was non-waking/dead bookkeeping: it persisted status/UI state but had no delivery path, so it never woke the parent and does not affect Pi-native warming. Historical records may still contain it and remain readable. A child inside an in-flight tool call is not marked idle merely because the tool is quiet. Needs-attention and all async completions surface immediately; each detached completion is delivered independently. Both async completion notifications and actionable async `needs_attention` notifications can synthetically wake an idle parent: the completion nudge is `[tlh] Background subagent completed — see notification above.`, while the control-notice nudge is `[tlh] Subagent run needs attention — see notice above.`. This is an interim workaround for an upstream Pi issue where extension-triggered turns skip system-prompt injection ([#470](https://github.com/diegopetrucci/the-last-harness/issues/470)); it will be removed when upstream is fixed.

**Current health versus history.** An idle `needs_attention` projection describes the child’s current health and is cleared by validated activity; that recovery rearms idle detection for a later, distinct episode. Compaction and in-flight tools are active operations, not idle recovery notices, and compaction is cleared only by its matching end event. Context pressure remains a diagnostic and notification input, not a durable attention cause. Historical control notices remain historical records, and older status records with retired attention-reason fields remain readable while those fields are dropped during normalization.

**Completion notification contract.** Each detached async result is delivered immediately as one `subagent-notify` message. There is no completion debounce, sibling grouping, or notification-level TTL dedupe: two siblings that finish ten milliseconds apart produce two notifications. The notification has one fixed single-run shape:

```text
Background task completed: **worker**

Output artifact: /path/to/output.md

Summary:
  child-derived summary (bounded)

Facts: #1 exit=0, duration=123ms, tokens=150, tools=1/0/2, workspace=exclusive

Session: /path/to/session.jsonl

Async id: run-id
Revive: subagent({ action: "resume", id: "run-id", message: "..." })
```

For a result without child rows but with a top-level session, the final pointer is instead emitted as a separate line after the recovery command: `Session file: /path/to/session.jsonl`. Child summary lines are indented so child text cannot become an artifact, session, fact, or recovery directive. The artifact path is shown first when an output artifact exists, followed by the bounded **joined** child summary (1200 characters total) and the validated A1c facts block. Session/revival pointers follow the facts. Output summaries and facts are independently bounded; paths, labels, and identifiers are sanitized and bounded as well. Protected paused/supervisor lifecycles intentionally omit child output, artifact paths, session paths, and facts, while retaining neutral resume/cancel actions. Failed and attention-worthy completions use this same shape immediately and are never held behind a delay.

**Completion ownership and wake ordering.** `result-watcher.ts` is the sole owner of detached completion delivery. It claims each result artifact through one exclusive persisted `<artifact>.claim` sidecar before normalizing and emitting `subagent:async-complete`; `notify.ts` only projects that event and does not dedupe it. The claim is created with mode `0600` and its parent result directory remains inside the isolated profile. The awaited owner claims its private artifact through the same arbitration path, and awaited artifacts never fall through to the public async-complete notification while a live owner for the matching lifecycle generation exists. The watcher publishes the completion message before `sendUserMessage` sends the idle follow-up nudge, so the wake turn can see the notification. After delivery, the result artifact and claim are removed together. If delivery succeeded but cleanup failed, the claim is retained through a bounded immediate-plus-backoff retry sequence (100/250/500/1000/2000 ms); after the finite attempts a single diagnostic is logged and the claim remains as a manual-recovery marker. A process crash or unknown delivery outcome therefore suppresses replay while the result artifact remains available for manual inspection. Startup and periodic scans remove `.json.claim` markers only when their corresponding artifact is absent. To recover deliberately, inspect the artifact first; remove `<artifact>.claim` only when replay is intended, then rescan/restart the watcher. Removing the sidecar without that intent can duplicate a notification.

### Terminal result and post-run facts

Each child may carry a `terminalResult` in its persisted status step and result-artifact item (and in the corresponding in-memory `SingleResult`). It is an evidence record, not a task-completion verdict. The terminal result uses `completed | failed | cancelled | paused`; `paused` means a durable `contact_supervisor` pause and its waiter is settled. Lifecycle readers accept `completed`, historical `complete`, and detached historical `continued` spellings. New awaited continuation owners settle their source lifecycle as `complete`; detached historical runs retain `continued` for compatibility.

The contract is:

```json
{
  "state": "completed",
  "facts": {
    "attempts": [
      {
        "attempt": 1,
        "exit": { "code": 0, "signal": null },
        "durationMs": 1234.5,
        "providerTokens": {
          "status": "available",
          "usage": { "input": 120, "output": 30, "total": 150 }
        },
        "requestedToolCalls": { "edit": 1, "write": 0, "bash": 2 },
        "workspace": {
          "baseline": {
            "status": "available",
            "statusPorcelainZ": "",
            "worktreeDiffStat": "",
            "indexDiffStat": ""
          },
          "post": {
            "status": "available",
            "statusPorcelainZ": " M src/example.ts\u0000",
            "worktreeDiffStat": " src/example.ts | 1 +",
            "indexDiffStat": ""
          },
          "attribution": "exclusive"
        }
      }
    ]
  }
}
```

`attempt` values are one-based and contiguous. A resumed or fallback child adds the next attempt; facts never collapse attempts into a single inferred outcome. A terminal result contains at least one and at most 64 attempts, with a 1 MiB aggregate UTF-8 cap across its snapshot evidence (each snapshot field is bounded separately as well). `durationMs` is a non-negative monotonic spawn-to-exit measurement. `providerTokens.status: "unavailable"` is distinct from an available usage value of zero. `requestedToolCalls` counts assistant-requested `edit`, `write`, and `bash` calls read from the child session; it does not claim that a tool ran successfully or changed the workspace.

Each attempt includes a dispatch-time `baseline` and a post-run `post` workspace observation. Available observations retain bounded raw `statusPorcelainZ` evidence—including its NUL delimiters—and bounded worktree/index diff-stat text. An unavailable observation is tagged `not_git_repository`, `command_failed`, or `not_captured`; a missing baseline maps to `not_captured`. `attribution` is `exclusive` when the child is the only tracked writer, `shared` when another tracked or awaited run overlapped the same cwd, and `unknown` when the repository or baseline could not establish attribution. None of these facts produces `madeChanges`, `completedWork`, or another derived verdict boolean.

When `terminalResult` is present at a JSON boundary, TLH validates the complete nested shape, rejects unknown keys and invalid numeric/tagged fields, and returns a fresh object. Historical status and result artifacts that omit the optional field remain readable through their existing compatibility paths. The field is per-child only; it is not added to the top-level async status/result envelope or generic `Details` object.

Compact completion and awaited result text also exposes a one-line `Facts:` summary after the output-artifact path block and before the session paths. It reports each retained attempt's exit or signal, rounded duration, provider-token total (or `?`), requested `edit/write/bash` counts, and workspace attribution. This is a compact view of the persisted evidence; it does not replace the status or result artifact and does not infer whether the child completed its task.

### Migration caveat

Existing historical run, session, and saved-chain artifacts are not rewritten or deleted; their status/history may remain readable. However, an older paused run whose persisted configuration depends on retired `steps`, fork/context inheritance, the removed external pi-intercom detach request/result/control integration, turn-budget behavior, or a retired execution timeout at an async-runner envelope/config root or plan root cannot be resumed under the reduced runtime. Remove only that retired envelope/plan-root timeout field and start a new direct single or parallel run instead. TLH-written per-step `plan.task.timeoutMs` and `plan.tasks[].timeoutMs` values remain valid trusted role-ceiling metadata and must not be removed. Normal direct-plan durable pause/resume remains supported when the plan uses the current contract.

### Context diagnostics are not inheritance

Persisted `contextUsage`, `contextPressure`, and `contextPressureCrossedThresholds` are measured diagnostics for status, pressure notifications, and durable-resume safety. They are not caller-supplied context, do not carry a parent transcript into a child, and do not change fresh-child startup. `contextUsage.contextTokens` records the latest valid per-response measurement; `peakTokens` and `restoredTokens` are diagnostic history rather than inherited input.

The fixed pressure bands (hardcoded, not configurable) are a warning at **80%** and critical at **95%** of the measured context window. A durable resume is blocked when the latest measured usage is at least 80%, and the guidance recommends a fresh narrowly scoped dispatch instead. Missing measurements are left missing rather than replaced with a guessed total.

### Child context-window policy

The **200,000-token effective context cap** applies to primary and other non-child TLH sessions. A child process is identified by TLH's child-runtime signal (`PI_SUBAGENT_CHILD=1`; the child-agent marker is accepted when that signal is absent). An explicit `PI_SUBAGENT_CHILD=0` keeps the process non-child even if a stale marker is present. The canonical developer policy additionally requires `PI_SUBAGENT_CHILD_AGENT=developer` and `PI_SUBAGENT_PROJECT_AGENT_GUIDANCE=1`, which is the parent-verified packaged-agent provenance. Child startup bypasses the primary cap instead of copying the parent's in-process window, and the policy is selected independently in the child without carrying the parent's transcript or context diagnostics into the fresh session.

For an enabled canonical packaged developer child, TLH sets each model's in-process `contextWindow` to `min(native context window, 272,000)`, uniformly across providers and model IDs. This applies the same ceiling to native windows such as 372k, 450k, and 1M while preserving smaller native windows unchanged. Other child roles retain their native context windows. Parent async-runner pressure/resume diagnostics select the matching role policy rather than the parent's mutated 200,000 registry value; canonical developer diagnostics therefore use the same 272,000 ceiling, while non-developer diagnostics retain native windows. When `tlh.contextCap.disabled` is `true`, canonical developer children and their diagnostics use native windows instead. The child override is process-local: TLH does not write `models.json` or profile settings, and restores any temporarily changed model windows during session shutdown. `/toggle-context-cap` applies or restores the matching policy in the current session.

### Native supervisor coordination

A child that needs a decision, structured interview, or meaningful progress update uses native `contact_supervisor`. Blocking requests durably pause the child; the parent then uses `subagent_supervisor({ action: "pending" })` or `subagent_supervisor({ action: "status" })` to inspect the native channel, followed by `subagent({ action: "resume", ... })` or `subagent({ action: "interrupt", ... })` to continue or cancel it. Custom/project agents with an active supervisor bridge receive neutral generic guidance; canonical packaged minor prompts already carry role-specific guidance and do not receive a duplicate block. This native supervisor channel and TLH's own status/lifecycle controls are the supported coordination surfaces; the removed external pi-intercom detach request/result/control integration is not supported. Separately installed user extensions remain untouched when TLH primary-agent filtering is disabled.

### Child protocol and display boundaries

Child stdout is a bounded newline-delimited protocol. Only validated event and message shapes drive orchestration; malformed or unknown lines cannot change run state. The optional debug artifact profile retains those protocol observations in the diagnostic child transcript for investigation. A protocol line over 16 MiB produces the deterministic `protocol_output_limit` failure and stops fallback retries, then the child receives SIGTERM and a bounded SIGKILL escalation if it does not exit. Surfaced child errors are bounded, in-memory message history is capped, and stderr is presented as a bounded diagnostic tail in results and status. The shared runner writes raw stderr to `output-N.log` for both awaited and detached runs regardless of artifact profile; debug mode additionally records it in the diagnostic child transcript. An oversized stderr line is diagnostic overflow, not a second control protocol.

Terminal controls are removed only when child-derived text crosses a display boundary. Single-line TUI rows and status or transcript/result fields that must remain one row use `safeTerminalText`, which normalizes CR/LF to spaces and strips terminal control sequences; binary-looking leaf values are replaced by a short placeholder. Legitimate multiline display content uses `safeTerminalDocument` for composed text whose leaves have already crossed a display boundary, or `safeTerminalDocumentLeaf` for a raw child-derived leaf when its newlines must remain while retaining the binary-placeholder policy. Async `output-N.log` files retain raw stderr regardless of profile. Debug child transcripts, output artifacts, metadata, and event records are not rewritten for display, so inspect those artifacts when exact retained child bytes are required.

### Child location line

The TLH footer always reflects the **parent** session's working directory and branch. When a child runs in the same directory as the parent, that footer is sufficient. When it does not — for example, a developer dispatched to a different worktree or an entirely separate repository — the footer alone cannot distinguish the two. To fill that gap, a child location line is captured once, at dispatch time, whenever the child's working directory differs from the parent session's working directory. Same-directory dispatches capture nothing and perform no git work.

The line renders as one dim line per child in the subagent widget (both single and parallel step lines) and in the awaited compact and expanded displays; the live-detail view uses the same expanded render path. It appears in every lifecycle state, including terminal ones, because it is parent-supplied dispatch metadata rather than child-reported telemetry. No git subprocess ever runs in a render or refresh path; the snapshot is taken once and stored, so display updates are free.

Rendered forms, from simplest to most detailed:

```
cwd: some/path
cwd: some/path · branch: feature-x
cwd: some/path · branch: detached@abc1234
cwd: some/path · repo: other-repo
cwd: some/path · repo: other-repo · branch: main
cwd: some/path · linked worktree · branch: feature-x
cwd: some/path · no git repo
```

Parts are ordered broad to narrow: the working directory first, then the repository name when the child is in a different repository from the parent, then a linked-worktree marker, then branch or detached HEAD, then a no-git-repo marker when the directory is not inside any git repository. Parts that match the parent are omitted, which is why a child working in the same repository but on a different branch shows only `branch:`, not `repo:`.

**Known limitation:** the snapshot is written to the status step when a step starts. A queued run, or a task still waiting behind a concurrency limit, shows no location line until the step actually begins.

## Prompt-cache warming

Pi-native prompt-cache warming sends a one-token provider refresh when Pi estimates at least $0.05 in avoided cache-miss cost. Refresh usage is recorded as `cache_warm` entries and counted toward session totals; it does not enter model context. `/session` shows Pi's current warm mode and next decision.

TLH ships `cacheWarming: "idle"` as a packaged default in `config/settings.defaults.json`. Install and update apply this value using an append-if-missing merge: when `cacheWarming` is absent from the isolated profile's `settings.json` it is written as `"idle"`; an existing user value is preserved untouched. To revert to Pi's native `streaming` mode (warm while a run is active) or to disable warming, set `cacheWarming` to `streaming` or `off` in `/settings` or directly in `~/.the-last-harness/agent/settings.json`. The packaged default does **not** re-apply after you set your own value.

TLH also registers a `cache_warming_decision` hook in the subagent extension. While async children are live, the hook substitutes P=1 for Pi's idle prior of 0.15, returning `warm` when missCost − warmCost ≥ $0.05; otherwise it abstains and lets Pi's own decision stand. A prior extension returning a stop decision can be overridden by this warm response; a later extension that returns a stop decision will still win. The hook does not generate new provider requests — it returns an action during Pi's existing cache-warming gate.

### Limits and accepted regressions

- **Anthropic models only**: Pi's `promptCache` lifetime metadata is declared only for Anthropic models. OpenAI/Codex and other models lack prompt-cache lifetime declarations and are never eligible for cache warming; there is no warming path for those models.
- **Adaptive-thinking models only**: When reasoning is enabled, Claude models using budget-based (non-adaptive) thinking are not replayable for cache warming and are skipped. Claude models with `forceAdaptiveThinking` (adaptive thinking) are replayable and remain eligible.
- **30-minute idle ceiling**: Pi's idle warmer tracks each session's most recent real provider request. A child session idle for longer than ~30 minutes (the `short`-tier TTL ceiling) goes cold; approximately 6 refreshes at ~4.5-minute intervals are achievable within that window. Children idle longer than that are uncovered.
- **`PI_CACHE_RETENTION=long` sessions**: When the `long` retention tier is active, Pi's idle warmer fires its first refresh at ~54 minutes. The idle ceiling is the same, so those sessions receive no idle refresh and remain at risk of a cold cache on the next real turn.
- **Per-refresh gate, not cumulative**: Pi's $0.05 expected-savings gate is evaluated independently on each potential refresh decision, not accumulated across refreshes.

### Observable evidence

- `/session` shows the current warming mode and Pi's next economic decision.
- `Cache warmed ...` transcript notices appear by default (`showCacheMissNotices: true` in TLH unless disabled).
- `cache_warm` entries appear in `/tokens` usage.

### Legacy heartbeat key

TLH's async-parent prompt-cache heartbeat has been retired and its code removed. A `heartbeat` key in `~/.the-last-harness/agent/extensions/subagent/config.json` is silently ignored at runtime. The file `~/.the-last-harness/agent/subagents/heartbeat.jsonl`, if present, is left in place as a historical record and is not deleted.

`/subagents-doctor` prints a Notices section when a legacy `heartbeat` key is present in the isolated config. The key is silently ignored at runtime and can be removed manually; TLH never edits it.

## Fallbacks and artifacts

### Fallback ordering and retry classification

TLH dispatches the exact configured model strings in deterministic order: the primary model, followed by provider role defaults and the agent's `fallbackModels`, with exact duplicate entries removed. No model catalog or availability snapshot filters candidates, and explicit model overrides are forwarded to Pi unchanged apart from surrounding whitespace. When model scope enforcement is enabled, it remains a pure allow-list check.

A fallback retry occurs only for classified transient provider failures: rate/usage limits, network or timeout errors, `stream ended without finish_reason`, and explicitly identified provider/HTTP 5xx responses. Standalone numbers such as ticket IDs or costs are not status evidence. Pi model-argument rejections, authentication/configuration errors, ordinary task errors, and deterministic child-tool failures are surfaced without retrying under another model. `attemptedModels` and `modelAttempts` contain the ordered effective model argv strings actually sent to Pi after configured thinking suffixes and deduplication. Durable `modelResolution` identity/history is recorded only when a canonical provider-qualified identity exists.

### Artifact profiles and recovery

Per-child run artifacts are written by default using the **compact** profile. The caller-facing `artifacts` Boolean only controls whether those run artifacts are written; it does not choose diagnostic detail. Compact is intentionally the normal retention level:

- **Retained:** supervisor-facing output (`*_output.md` when run artifacts are requested, and async `output-N.log`, whose raw stderr is retained in every profile), metadata (`*_meta.json`) when run artifacts are requested (compact metadata omits the full `task` text; debug and historical mode-less detached metadata retain it), plus lifecycle/status data and the canonical child session (`session.jsonl`) used for ordinary recovery.
- **Omitted:** task input (`*_input.md`), the diagnostic child transcript (`*_transcript.jsonl`), and high-volume child-event projections. Compact `events.jsonl` can still contain bounded runner diagnostics such as stderr truncation/overflow notices or protocol-limit records, but it omits ordinary per-line stderr events; its existence is not a promise that a full child transcript was retained.
- **Failures:** result/status diagnostics retain a bounded stderr tail. The shared runner's `output-N.log` retains raw stderr for both awaited and detached runs in every profile; debug additionally provides the diagnostic child transcript.

`subagent({ action: "status", id: "...", view: "transcript" })` is a **status transcript view**, not a read of the optional `_transcript.jsonl` diagnostic artifact. It renders retained output, recent status output, or the canonical session tail. The view can remain useful when compact mode has no diagnostic transcript. The canonical child session is the ordinary recovery record; use the status/session pointers to inspect or resume a paused or failed run.

For a failure that requires the diagnostic child transcript or surrounding child protocol, set the human-owned profile before reproducing it. Result/status diagnostics retain a bounded stderr tail, while `output-N.log` already retains raw stderr for both awaited and detached runs regardless of profile.

```json
{
  "artifacts": {
    "mode": "debug"
  }
}
```

Merge this block into the existing config; do not replace the file or remove existing `control` or other keys. Debug restores the task-input file, the bounded diagnostic `_transcript.jsonl`, and high-volume child-event projections; output, metadata, and canonical sessions remain available as usual. The `artifacts.mode` value is not a model-facing tool parameter. Install and update preserve this human-owned value and other unrelated config keys while enforcing the managed attention policy documented below. The config reader preserves unknown legacy fields and the runtime ignores unrecognized status-display settings; no obsolete display defaults are added back.

After editing `<agent-dir>/extensions/subagent/config.json`, reload the extension with `/reload` or stop and restart the `tlh` process before starting a new run. A run already underway retains its resolved policy. To undo the opt-in, remove the `artifacts` block (compact is the absent-key default) or set `"mode": "compact"`, then reload or restart. Existing files are not deleted by this change; inspect them first and remove project artifacts with `rm -rf .pi-subagents` only after confirming they are no longer needed.

Project-scoped artifact paths use `.pi-subagents/artifacts/`; otherwise the runtime uses a directory beside the parent session or a managed temporary directory. Explicit output paths are resolved from the run's working directory, and `outputMode: "file-only"` returns a concise saved-file reference.

## Configuration and diagnostics

The active runtime config is:

```text
<agent-dir>/extensions/subagent/config.json
```

For the default release profile that is `~/.the-last-harness/agent/extensions/subagent/config.json`. The installer-managed attention policy in this file sets `control.needsAttentionAfterMs` to exactly `180000` ms (3 minutes), removes the retired `control.activeNoticeAfterMs`, `control.activeNoticeAfterTurns`, `control.activeNoticeAfterTokens`, and `control.failedToolAttemptsBeforeAttention` keys, and scrubs `active_long_running` entries from `control.notifyOn`, even when customized. Specifically, `control.notifyOn: ["active_long_running"]` becomes `control.notifyOn: []`, preserving its effective disabled-notification behavior; when other entries are present, only the retired entry is removed. It applies only to persistent isolated-profile configuration; per-dispatch runtime overrides remain available. A changed valid existing config is backed up to `config.json.backup-*` before writing; a missing config and an already-converged config create no backup. These backups (`extensions/subagent/config.json.backup-*`) are not covered by root-profile backup pruning and are retained until manually removed; inspect them and remove only matching files in `<agent-dir>/extensions/subagent/`, not the active `config.json` or the whole profile. `--dry-run` reports the planned migration without writing or backing up. `tlh doctor` is read-only, while `tlh doctor --repair` applies the same guarded migration and backs up changed configs. Malformed, unreadable, non-object, or structurally unsafe config is preserved with an actionable warning. Unrelated top-level/control keys and human-owned `execution.maxRunTimeMs` and `artifacts.mode` are preserved. To roll back, inspect a chosen backup in `<agent-dir>/extensions/subagent/`, copy it over only that directory's `config.json`, and reload/restart; this is temporary because a later install or update re-enforces `180000` and removes retired keys. Existing `toolDescriptionMode` keys are ignored, intentionally preserved by install/update, and may be manually deleted; restore a pre-update `settings.json.backup-*` when undoing an isolated-settings merge.

Parallel limits are configured here: `parallel.maxTasks` accepts values from `1` through `8` and caps tasks per call (default `8`); values above `8` are bounded to `8` so the status and terminal-attribution envelope stays within its 16 MiB reader limit, while invalid or omitted values use the default. `parallel.concurrency` caps simultaneously running children (default `4`).

Useful diagnostics:

- `tlh doctor` checks installer-owned profile resources without writing.
- `tlh doctor --repair` can restore bundled agent definitions and settings defaults after backing up settings.
- `/subagents-doctor` reports runtime-specific diagnostics, including the shared run ceiling and fresh-per-spawn role-deadline policy.
- `subagent({ action: "status", id: "..." })` reports the selected active run and its children; use `view: "transcript"` with optional `lines: 1` through `500` to inspect retained output.
- When parallel work is rejected or queued, inspect `parallel.maxTasks` and `parallel.concurrency` in the active config.

See [commands.md](commands.md) for command visibility and [install.md](install.md) for the exact install/update migration and uninstall behavior.

## Provider auth-health warning

When TLH dispatches a subagent and the provider's credential fails, a sticky footer warning appears:

```text
⚠ reauth: anthropic
```

The warning is per-provider (both providers are shown in one line when both fail: `⚠ reauth: anthropic, openai-codex`) and **outlives the run that revealed it** — it does not disappear when the failing run finishes. It clears automatically once the credential works again, checked at each dispatch and turn boundary, so no restart is needed. A new session starts clean and re-flags on the next failed dispatch. A toast notification pointing at `/login` appears the first time a provider is flagged within a session.

Credential failures are detected at dispatch time and also from completed runs, including async ones — so a silently degraded `code-reviewer`, `oracle`, or `contrarian` is surfaced even when the failure happened after the tool call returned.

Only unambiguous credential rejections (revoked/expired OAuth grants, 401/403 during token refresh) surface this warning. Transient network failures, rate limits, and server errors are silent — they are retried automatically on the next dispatch.

## Updating, migrating, and removing

See the [migration caveat](#migration-caveat) for historical artifacts and paused runs, and [custom-agent/settings migration](custom-subagents.md#migrate-from-an-older-profile-definition) for cleanup steps.

`tlh update` updates the first-party runtime together with the rest of TLH. It does not download or publish a standalone subagent package. On legacy profiles, install/update removes a retired external subagent package only when TLH can establish that it managed that package. Profiles with provenance preserve a matching manually owned entry; pre-provenance profiles treat the old default identities as TLH-managed for the one-time migration.

If a manually owned external npm/git subagent package remains in user or project settings, the first-party runtime refuses to register a second copy and emits a warning naming the scope. Remove the external source through the same scope in which it was installed (`tlh remove <source>` for user scope, or `tlh remove <source> -l` for project scope), then run `tlh update` and restart. Preserve and inspect unfamiliar files before removal.

Local/path external installs are recognized by neither migration ownership nor the coexistence guard. TLH will not remove them or warn before the first-party runtime registers, so remove or disable that external resource in its original user/project scope **before** a normal launch to avoid duplicate tool registration.

Retry-preserved evidence applies only to a failed managed npm uninstall. Guarded git cleanup is best-effort: unsafe paths and removal failures warn while settings can still converge, leaving an inert checkout beneath `<agent-dir>/git`. Inspect the exact path from the warning (`git -C "<exact-checkout-path>" remote -v` is useful), then remove only that confirmed retired checkout. Never broadly delete `<agent-dir>/git`, because it may contain unrelated user-owned packages.

There is no `tlh defaults disable subagents` opt-out: subagents are first-party workflow infrastructure, not a separately managed default extension. For one-run diagnosis, `tlh --no-extensions` disables all extensions without persisting a setting. `tlh config` can persistently disable the root-package `./extensions/subagents/src/extension/index.js` resource, but that breaks architect delegation and is not a supported steady state; run `tlh config` again and re-enable the same resource to recover. To remove the persistent TLH installation, use the uninstaller documented in [install.md](install.md). It removes the isolated profile (including first-party runtime state and copied agent definitions) and the owned private runtime, but it does not delete repo-local `.pi-subagents/`, `.gnosis/`, or `.tickets/` data.

## Provenance and license

The imported implementation retains its exact snapshot provenance under [subagents-history/HISTORY.md](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/subagents-history/HISTORY.md). The historical source archive is not active TLH configuration and must not be used as current install, release, publication, or sync guidance. Its archived instruction filenames can become project context if a task starts inside that directory, so never use `docs/subagents-history/source/` as a task `cwd`. TLH ships Nico Bailon's MIT notice at [`extensions/subagents/LICENSE`](../extensions/subagents/LICENSE); the repository's own root [`LICENSE`](../LICENSE) remains separate and unchanged.
