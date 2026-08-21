# First-party subagents

Subagent orchestration is part of TLH itself. The runtime entrypoint ships at `extensions/subagents/src/extension/index.js`, the bundled agent definitions ship under `agents/subagents/`, and the TLH package declares the runtime in `package.json` under `pi.extensions`. There is no separate subagent package to install, pin, publish, or update for TLH.

Most users should delegate in natural language to the active primary agent. The architect chooses the appropriate bundled agent, supervises the run, and judges the result. The runtime details below are mainly useful when diagnosing a run or developing TLH.

## Isolation and discovery

The managed wrapper sets `PI_CODING_AGENT_DIR` to the isolated TLH profile before the upstream Pi runtime starts. Subagent settings, copied agent definitions, child sessions, and runtime state therefore stay under that active profile instead of normal `~/.pi/agent`. Child processes resolve the same private Pi runtime as their parent; an unusable resolved runtime fails clearly instead of silently falling back to an ambient global `pi`.

TLH copies its eight minor-agent definitions to `<agent-dir>/tlh/agents/subagents` and keeps that directory in the isolated `subagents.agentDirs` setting. For primary-agent delegation, TLH also forces the bundled agents to user scope and fresh context. This prevents project or legacy-profile definitions from shadowing them and prevents the parent's primary-agent or Gnosis context from leaking into a child. The underlying runtime retains generic project-scope and fork-context support for compatible non-primary entrypoints, but those are not the bundled TLH delegation policy.

The bundled minor agents are `developer`, `code-reviewer`, `repo-scout`, `diff-summarizer`, `librarian`, `web-scout`, `oracle`, and `contrarian`. The built-in definitions that shipped with the upstream runtime have been removed outright; only these eight TLH minor agents exist. Trusted user-owned `embedded.<slug>` agents are a separate default-off feature documented in [embedded-subagents.md](embedded-subagents.md).

## Dispatch and tool surface

The model-facing `subagent` tool deliberately has a small, fail-closed surface:

- **Single:** one `agent` and optional `task`.
- **Parallel:** a `tasks` array, with optional `concurrency`. Each task names an `agent` and `task` and may override output, reads, progress, or model behavior.
- **Synchronous by default:** the tool waits for the child result.
- **Asynchronous when requested:** `async: true` starts detached work and returns an ID and runtime directory so the parent can continue useful work.
- **Execution controls:** `context`, `timeoutMs`, `cwd`, `artifacts`, and `includeProgress`; single runs also accept `output`, `outputMode`, `model`, and `fallbackModels`. Execution is action-free for single/parallel runs; legacy `action: "single"`, `action: "parallel"`, `action: "tasks"`, and `maxRuntimeMs` inputs are not accepted.

The runtime capability gate drops a thinking level only when positive registry metadata rules it out: `reasoning: false`, a `null` level mapping, or a present map that omits `xhigh` or `max`. Missing capability metadata and unknown or unresolvable models fail open and still receive the suffix. Already-suffixed model arguments short-circuit before capability checks, and an explicit caller `thinkingOverride` is exempt from the gate. Each drop emits a note naming the level and model.

The supported actions are `list`, `get`, `status`, `interrupt`, `resume`, `steer`, and `doctor`. Saved chains and chain dispatch are intentionally not part of the current TLH contract. Mutating agent-management actions such as create/delete/reset are also not exposed through the model-facing schema; user-owned custom agents remain markdown files managed through the documented profile/project paths.

Keep one writer per working directory. Parallel developers writing the same checkout can race even though their session contexts are isolated; use parallelism for read-only discovery/review or independent workspaces, and keep one owner for edits.

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

For built-in agents, an entry keyed by the agent's plain name under `subagents.agentOverrides` in `settings.json` also accepts `skills` as a string array, or `false` to disable skills for that agent. The frontmatter value takes precedence over the override for any field both define:

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

Set `"skills": false` in the override to disable skills for agents whose frontmatter does NOT declare `skill:` or `skills:`; when the frontmatter declares them, the override is ignored entirely.

### Resolution sources and search order

When a run starts, the runtime walks the following locations and collects all skill directories (each containing a `SKILL.md` file, whose parent directory name becomes the skill name). When the same name appears in multiple locations, the source with the **highest priority number wins**. This ordering is defined by `SOURCE_PRIORITY` in `skills.ts` and assembled by `buildSkillPaths`.

| Priority | Source | Typical path |
|---|---|---|
| 700 | `project` | `.pi/skills/` or `.agents/skills/` in the project root |
| 650 | `project-settings` | Paths listed under `skills` in `.pi/settings.json` |
| 600 | `project-package` | `.pi/npm/node_modules/<pkg>` (via `pi.skills` in `package.json`) or project root `package.json` → `pi.skills` |
| 300 | `user` | `<agent-dir>/skills/` |
| 250 | `user-settings` | Paths listed under `skills` in `<agent-dir>/settings.json` |
| 200 | `user-package` | `<agent-dir>/npm/node_modules/<pkg>` or the global npm root |
| 180 | `project-claude` | `.claude/skills/` in the project root ² |
| 170 | `user-claude` | `~/.claude/skills/` ² |
| 150 | `extension` | Not assigned by `buildSkillPaths` or `inferSkillSource`; only reachable via an explicit `sourceHint` ¹ |
| 100 | `builtin` | Not assigned by `buildSkillPaths` or `inferSkillSource`; only reachable via an explicit `sourceHint` ¹ |
| 0 | `unknown` | Anything that does not match a known root |

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

If a named skill is not found in any search location after both passes, it is added to the `missing` list and the run **continues**. For foreground runs, a warning string `Skills not found: <name>, ...` is attached to the result and shown in the TUI as a warning line alongside the run output; async runs currently continue silently without surfacing the warning.

Exception: if `pi-subagents` is requested, the run **fails immediately** rather than continuing — see below.

### The `pi-subagents` skill

The skill named `pi-subagents` can never be injected into a child. Children have no `subagent` tool (`registerSubagentExtension` is skipped for child processes), so orchestration instructions reaching a child would be unactionable and violate the "subagents cannot spawn subagents" boundary.

Requesting `pi-subagents` as a skill **fails the run immediately** with `"Skills not found: pi-subagents"` rather than continuing with a warning. The `resolveSkills` function hardcodes this skill name to always go to the `missing` list, regardless of whether a matching file exists on disk. This is intentional — users who see this error should remove `pi-subagents` from their agent's `skill:` declaration.

### `skills` vs `inheritSkills`

These two mechanisms are distinct:

| | `skills` (frontmatter) | `inheritSkills` (frontmatter) |
|---|---|---|
| What it does | Injects specific named skills into the child's system prompt | Passes the *parent's* existing skills section down to the child |
| Default | None (no injection) | `false` (parent skills stripped by `rewriteSubagentPrompt`) |
| Format | Comma-separated skill names, or array in settings override | Boolean (`true`/`false`) |
| When to use | Give an agent a specific runbook or checklist | Let a child share the parent's ambient skill context |

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

An asynchronous receipt includes an `asyncId` and `asyncDir`. Status and lifecycle data are persisted there, including `status.json`, `events.jsonl`, and output/log references. Use `subagent({ action: "status", view: "fleet" })` for the read-only fleet view or `subagent({ action: "status", id: "..." })` for a specific model-facing status path.

The runtime distinguishes these controls:

- `steer` queues guidance to a currently live async child without first pausing it.
- `resume` with a live child is an acknowledged follow-up/nudge path; the live child is interrupted before the follow-up is delivered.
- `interrupt` is a soft, resumable interruption for active work. Applied to an already durable paused child, it cancels that continuation.
- A blocking supervisor decision pauses durably. No child process remains alive while paused; persisted lifecycle/session data is used when the parent later chooses unchanged resume, guided resume, or cancellation.

Control signals distinguish `active_long_running` from `needs_attention`. A child inside an in-flight tool call is not marked idle merely because the tool is quiet. Needs-attention and failure/pause events surface immediately; successful async completions may be batched to avoid notification spam. When an async notification arrives while the parent session is idle, the runtime wakes the parent by sending a short machine-marked user message prefixed `[tlh]` (e.g. `[tlh] Background subagent completed — see notification above.`). This is an interim workaround for an upstream Pi issue where extension-triggered turns skip system-prompt injection ([#470](https://github.com/diegopetrucci/the-last-harness/issues/470)); it will be removed when upstream is fixed.

**Completion notification sizing.** Each async completion embeds up to 8,000 characters of the child's result inline; roughly 96 percent of real-world results now arrive complete in the notification, up from about 35 percent under the previous 1,200-character cap. Every completion notification is bounded by a 32,000-character ceiling, an increase from the previous 8,000. That ceiling applies whatever the notification's shape: a single parallel dispatch with four children can approach it on its own, as can a batch grouping several completions that arrived within a short window. Architect sessions that previously treated the completion notice as a teaser and always fetched the artifact separately should find that practice unnecessary in the common case.

**Pointer-survival invariant.** `formatSingleCompletion` emits the artifact path and session reference lines last, and the send-time cap in `sendCompletion` truncates from the end. An overflow therefore destroys the recovery pointer before it destroys summary text, turning *truncated but recoverable* into *truncated and unrecoverable*. The invariant is enforced across six sites with no single home: `resolvePerChildSummaryBudget` and the non-summary cost computation in `formatResultPreview` perform the primary reservation by subtracting all fixed scaffold costs before dividing the remainder among child summaries; `fitPreviewWithinCeiling` and `joinedLineCost` enforce the per-entry ceiling in grouped messages; and the per-entry bound in `formatGroupedCompletion` and the send-time cap in `sendCompletion` provide final guardrails. The failure mode is under-reservation — reserving too little space for scaffolding, so the assembled message quietly overshoots the ceiling and the end-cut eats the pointer. Over-reservation is always safe and is the deliberate choice here: `joinedLineCost` over-counts by one character per line for exactly this reason. If you are editing header lines, formatting, or constants in `notify.ts`, keep the arithmetic erring towards reserving more space, never less.

Paused/interrupted runs record acceptance as skipped rather than rejected. A continuation inherits the paused ledger's effective acceptance contract and provenance, and a resume-time override may only strengthen it. A later follow-up from a completed or failed run does not inherit the old contract.

### Native supervisor coordination

A child that needs a decision, structured interview, or meaningful progress update uses `contact_supervisor`. Blocking requests durably pause the child; the parent then uses `subagent_supervisor({ action: "pending" })` or `subagent_supervisor({ action: "status" })` to inspect the native channel, followed by `subagent({ action: "resume", ... })` or `subagent({ action: "interrupt", ... })` to continue or cancel it. The native child runtime does not register or advertise an `intercom` fallback, and the parent supervisor tool has no legacy list/send/ask/reply actions. Separately installed external intercom tools remain user-owned and are not overridden when TLH primary-agent filtering is disabled.

## Acceptance and artifacts

TLH infers self-contained acceptance from the agent role and task intent. Read-only work normally uses an attested report; writer work normally uses checked evidence. Explicit `reviewed` dispatch is rejected because this runtime does not manufacture an independent reviewer result. Verified acceptance is meaningful only when the calling surface supplies actual verification commands. The architect remains the intelligent judge and decides when a separate `code-reviewer` pass is warranted.

Debug artifacts are enabled by default. Project-scoped artifact paths use `.pi-subagents/artifacts/`; otherwise the runtime uses a directory beside the parent session or a managed temporary directory. Explicit output paths are resolved from the run's working directory, and `outputMode: "file-only"` returns a concise saved-file reference. Inspect artifacts before retrying a failed or interrupted run; remove project artifacts with `rm -rf .pi-subagents` only after confirming they are no longer needed.

## Configuration and diagnostics

The active runtime config is:

```text
<agent-dir>/extensions/subagent/config.json
```

For the default release profile that is `~/.the-last-harness/agent/extensions/subagent/config.json`. Install and update add only missing TLH defaults: compact tool descriptions and `control.activeNoticeAfterMs: 270000` (4m30). Existing values and unrelated keys survive. Remove a customized key and run `tlh update` to restore the managed default; restore a pre-update `settings.json.backup-*` when undoing an isolated-settings merge.

Useful diagnostics:

- `tlh doctor` checks installer-owned profile resources without writing.
- `tlh doctor --repair` can restore bundled agent definitions and settings defaults after backing up settings.
- `/subagents-doctor` reports runtime-specific diagnostics.
- `subagent({ action: "status", view: "fleet" })` reports active runs and transcript commands.

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

`tlh update` updates the first-party runtime together with the rest of TLH. It does not download or publish a standalone subagent package. On legacy profiles, install/update removes a retired external subagent package only when TLH can establish that it managed that package. Profiles with provenance preserve a matching manually owned entry; pre-provenance profiles treat the old default identities as TLH-managed for the one-time migration.

If a manually owned external npm/git subagent package remains in user or project settings, the first-party runtime refuses to register a second copy and emits a warning naming the scope. Remove the external source through the same scope in which it was installed (`tlh remove <source>` for user scope, or `tlh remove <source> -l` for project scope), then run `tlh update` and restart. Preserve and inspect unfamiliar files before removal.

Local/path external installs are recognized by neither migration ownership nor the coexistence guard. TLH will not remove them or warn before the first-party runtime registers, so remove or disable that external resource in its original user/project scope **before** a normal launch to avoid duplicate tool registration.

Retry-preserved evidence applies only to a failed managed npm uninstall. Guarded git cleanup is best-effort: unsafe paths and removal failures warn while settings can still converge, leaving an inert checkout beneath `<agent-dir>/git`. Inspect the exact path from the warning (`git -C "<exact-checkout-path>" remote -v` is useful), then remove only that confirmed retired checkout. Never broadly delete `<agent-dir>/git`, because it may contain unrelated user-owned packages.

There is no `tlh defaults disable subagents` opt-out: subagents are first-party workflow infrastructure, not a separately managed default extension. For one-run diagnosis, `tlh --no-extensions` disables all extensions without persisting a setting. `tlh config` can persistently disable the root-package `./extensions/subagents/src/extension/index.js` resource, but that breaks architect delegation and is not a supported steady state; run `tlh config` again and re-enable the same resource to recover. To remove the persistent TLH installation, use the uninstaller documented in [install.md](install.md). It removes the isolated profile (including first-party runtime state and copied agent definitions) and the owned private runtime, but it does not delete repo-local `.pi-subagents/`, `.gnosis/`, or `.tickets/` data.

## Provenance and license

The imported implementation retains its exact snapshot provenance under [subagents-history/HISTORY.md](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/subagents-history/HISTORY.md). The historical source archive is not active TLH configuration and must not be used as current install, release, publication, or sync guidance. Its archived instruction filenames can become project context if a task starts inside that directory, so never use `docs/subagents-history/source/` as a task `cwd`. TLH ships Nico Bailon's MIT notice at [`extensions/subagents/LICENSE`](../extensions/subagents/LICENSE); the repository's own root [`LICENSE`](../LICENSE) remains separate and unchanged.
