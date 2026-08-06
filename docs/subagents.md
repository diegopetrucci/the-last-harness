# First-party subagents

Subagent orchestration is part of TLH itself. The runtime entrypoint ships at `extensions/subagents/src/extension/index.js`, the bundled agent definitions ship under `agents/subagents/`, and the TLH package declares the runtime in `package.json` under `pi.extensions`. There is no separate subagent package to install, pin, publish, or update for TLH.

Most users should delegate in natural language to the active primary agent. The architect chooses the appropriate bundled agent, supervises the run, and judges the result. The runtime details below are mainly useful when diagnosing a run or developing TLH.

## Isolation and discovery

The managed wrapper sets `PI_CODING_AGENT_DIR` to the isolated TLH profile before the upstream Pi runtime starts. Subagent settings, copied agent definitions, child sessions, and runtime state therefore stay under that active profile instead of normal `~/.pi/agent`. Child processes resolve the same private Pi runtime as their parent; an unusable resolved runtime fails clearly instead of silently falling back to an ambient global `pi`.

TLH copies its eight minor-agent definitions to `<agent-dir>/tlh/agents/subagents` and keeps that directory in the isolated `subagents.agentDirs` setting. For primary-agent delegation, TLH also forces the bundled agents to user scope and fresh context. This prevents project or legacy-profile definitions from shadowing them and prevents the parent's primary-agent or Gnosis context from leaking into a child. The underlying runtime retains generic project-scope and fork-context support for compatible non-primary entrypoints, but those are not the bundled TLH delegation policy.

The bundled minor agents are `developer`, `code-reviewer`, `repo-scout`, `diff-summarizer`, `librarian`, `web-scout`, `oracle`, and `contrarian`. The imported runtime also contains its original built-in definitions under `extensions/subagents/agents/`, but managed settings keep them disabled with `subagents.disableBuiltins: true`; only the eight TLH minor agents are supported. Do not enable the imported built-ins, which include overlapping names such as `oracle`. Trusted user-owned `embedded.<slug>` agents are a separate default-off feature documented in [embedded-subagents.md](embedded-subagents.md).

## Dispatch and tool surface

The model-facing `subagent` tool deliberately has a small, fail-closed surface:

- **Single:** one `agent` and optional `task`.
- **Parallel:** a `tasks` array, with optional `concurrency`. Each task names an `agent` and `task` and may override output, reads, progress, or model behavior.
- **Synchronous by default:** the tool waits for the child result.
- **Asynchronous when requested:** `async: true` starts detached work and returns an ID and runtime directory so the parent can continue useful work.
- **Execution controls:** `context`, `timeoutMs`, `cwd`, `artifacts`, and `includeProgress`; single runs also accept `output`, `outputMode`, `model`, and `fallbackModels`.

The runtime capability gate drops a known-unsupported thinking level instead of emitting its suffix. Unknown or unresolvable models fail open and still receive the suffix. An explicit caller `thinkingOverride` is exempt from the gate. Each drop emits a note naming the level and model.

The supported actions are `list`, `get`, `models`, `status`, `interrupt`, `resume`, `steer`, and `doctor`. Saved chains and chain dispatch are intentionally not part of the current TLH contract. Mutating agent-management actions such as create/delete/reset are also not exposed through the model-facing schema; user-owned custom agents remain markdown files managed through the documented profile/project paths.

Keep one writer per working directory. Parallel developers writing the same checkout can race even though their session contexts are isolated; use parallelism for read-only discovery/review or independent workspaces, and keep one owner for edits.

## Async control, pause, and resume

An asynchronous receipt includes an `asyncId` and `asyncDir`. Status and lifecycle data are persisted there, including `status.json`, `events.jsonl`, and output/log references. Use `/subagents-fleet` for the interactive fleet view or `subagent({ action: "status", id: "..." })` for the model-facing status path.

The runtime distinguishes these controls:

- `steer` queues guidance to a currently live async child without first pausing it.
- `resume` with a live child is an acknowledged follow-up/nudge path; the live child is interrupted before the follow-up is delivered.
- `interrupt` is a soft, resumable interruption for active work. Applied to an already durable paused child, it cancels that continuation.
- A blocking supervisor decision pauses durably. No child process remains alive while paused; persisted lifecycle/session data is used when the parent later chooses unchanged resume, guided resume, or cancellation.

Control signals distinguish `active_long_running` from `needs_attention`. A child inside an in-flight tool call is not marked idle merely because the tool is quiet. Needs-attention and failure/pause events surface immediately; successful async completions may be batched to avoid notification spam.

Paused/interrupted runs record acceptance as skipped rather than rejected. A continuation inherits the paused ledger's effective acceptance contract and provenance, and a resume-time override may only strengthen it. A later follow-up from a completed or failed run does not inherit the old contract.

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
- `/subagents-fleet` reports active runs and transcript commands.

See [commands.md](commands.md) for command visibility and [install.md](install.md) for the exact install/update migration and uninstall behavior.

## Updating, migrating, and removing

`tlh update` updates the first-party runtime together with the rest of TLH. It does not download or publish a standalone subagent package. On legacy profiles, install/update removes a retired external subagent package only when TLH can establish that it managed that package. Profiles with provenance preserve a matching manually owned entry; pre-provenance profiles treat the old default identities as TLH-managed for the one-time migration.

If a manually owned external npm/git subagent package remains in user or project settings, the first-party runtime refuses to register a second copy and emits a warning naming the scope. Remove the external source through the same scope in which it was installed (`tlh remove <source>` for user scope, or `tlh remove <source> -l` for project scope), then run `tlh update` and restart. Preserve and inspect unfamiliar files before removal.

Local/path external installs are recognized by neither migration ownership nor the coexistence guard. TLH will not remove them or warn before the first-party runtime registers, so remove or disable that external resource in its original user/project scope **before** a normal launch to avoid duplicate tool registration.

Retry-preserved evidence applies only to a failed managed npm uninstall. Guarded git cleanup is best-effort: unsafe paths and removal failures warn while settings can still converge, leaving an inert checkout beneath `<agent-dir>/git`. Inspect the exact path from the warning (`git -C "<exact-checkout-path>" remote -v` is useful), then remove only that confirmed retired checkout. Never broadly delete `<agent-dir>/git`, because it may contain unrelated user-owned packages.

There is no `tlh defaults disable subagents` opt-out: subagents are first-party workflow infrastructure, not a separately managed default extension. For one-run diagnosis, `tlh --no-extensions` disables all extensions without persisting a setting. `tlh config` can persistently disable the root-package `./extensions/subagents/src/extension/index.js` resource, but that breaks architect delegation and is not a supported steady state; run `tlh config` again and re-enable the same resource to recover. To remove the persistent TLH installation, use the uninstaller documented in [install.md](install.md). It removes the isolated profile (including first-party runtime state and copied agent definitions) and the owned private runtime, but it does not delete repo-local `.pi-subagents/`, `.gnosis/`, or `.tickets/` data.

## Provenance and license

The imported implementation retains its exact snapshot provenance under [subagents-history/HISTORY.md](subagents-history/HISTORY.md). The historical source archive is not active TLH configuration and must not be used as current install, release, publication, or sync guidance. Its archived instruction filenames can become project context if a task starts inside that directory, so never use `docs/subagents-history/source/` as a task `cwd`. TLH ships Nico Bailon's MIT notice at [`extensions/subagents/LICENSE`](../extensions/subagents/LICENSE); the repository's own root [`LICENSE`](../LICENSE) remains separate and unchanged.
