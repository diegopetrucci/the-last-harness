# The last harness you'll ever need.

[![CI](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/diegopetrucci/the-last-harness/total)](https://github.com/diegopetrucci/the-last-harness/releases)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdiegopetrucci%2Fthe-last-harness%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=339933&logo=nodedotjs)](package.json)

`tlh` (The Last Harness) is an opinionated harness built on top of [Pi](https://github.com/earendil-works/pi).

Two core ideas drive it:

- _"you can outsource your thinking, but not your understanding"_: LLMs can, and should, provide options, help out with discovery and exploration, filling the gaps in your understanding and technical knowledge — they should not, however, be used as a replacement for understanding. [Beware of cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/).
- _you should not be babysitting your agents_: if you need to manually call tools, run commands, and so on, the harness has failed you.

It achieves this [via a custom orchestration workflow](https://www.stavros.io/posts/how-i-write-software-with-llms/) — you only interface with an architect, whom you engage as a senior peer, and once you're satisfied with the discussion and plan, it takes over until everything is done. Work is pre-reviewed too, often multiple times, so that your time is not wasted in minutiae, freeing you to focus on the bigger picture.

You're also not asked to manually run commands, manage context, or anything like that. This is built-in and done for you. Every further action that you take is because you _want_ to take it, not because you _have_ to. You should not be finding yourself thinking eg "oh, I forgot to trigger a review". Your time is worth more.

`tlh` is also slow by default, and relatively token-expensive: it is designed to be used as a long-running, reliable, and predictable tool. You spend time preparing the work, and once it's off, it's off. No babysitting.

If this resonates with you, welcome aboard:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

The official release installer verifies SHA-256 checksums for every successfully fetched remote stage-0 support file before running stage 1. Raw source, mutable/custom refs, and local checkouts remain supported but are not release-integrity verified; see [the install and recovery notes](docs/install.md#release-installer-integrity).

## Workflows

`tlh` has a few primary workflows/personas: architect, rush, product, bug-hunter, disabled. Each of them has different purpose, encoded with a different system prompt, available tools, and subagents. You can switch between primary agents at any time by pressing `shift` + `tab` — but I would suggest to try not to cross-contaminate the same session (start new ones!).

### The architect

![Illustration of the TLH architect-first workflow: a request passes through approval, tk tickets, scout/build/review child sessions, and returns a judged result.](https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/assets/main-tlh-workflow-illustrations/01-main-tlh-workflow.png)

As a software engineer, you will likely spend most of your time with the **architect** primary agent. The architect does not do any change directly, but its purpose is to help you investigate, find issues, plan the work, and so on. It is banned from making (bigger) direct changes, and it will always propose to encode the plan/work into smaller tickets.

At times, the architect might seem eager to ask you to `approve` the plan. Do not feel afraid to push back and continue exploring and understanding the stakes. This is _your_ work, own it, and explore all possibilities. Also feel free to start new sessions, and treat existing ones as throwaways to get a better idea of what's going on. Rarely one is able to come up with the shape of work on the first try.

The architect has access to a few subagents, which can be divided in three big categories:

- Single-purpose, automatically-invoked ones to keep its context smaller: the librarian to check git repos, web-scout for the internet, etc.
- Core: as the agent does not write code, 1+ developer(s) are tasked to. The reviewer works the same way, so reviews happen automatically rather than requiring a manual command.
- Second opinions: the oracle, and the contrarian. Both ship by default, but invoking them is optional: the architect might suggest using them, and it will always be up to you whether to actually run them.

Notably, the oracle, contrarian, and reviewer try to run on a different provider than your session, so the second opinion is actually independent. The exact fallback order lives in [docs/models.md](docs/models.md#review-independence-for-code-reviewer-oracle-and-contrarian).

Again, the core idea: explore and plan with the architect. Double check with the oracle/contrarian. Go back and forth. This is where you, as a human, are required. Once happy, the implementation follows, until ready for your review.

A few quick-fire tips to get the most of the architect:

- If the planned work is too big, ask the architect to delegate even just one tk ticket at a time to the developer. Final-validation tickets go to the execution-only test-runner, which can run exact shell and generic MCP steps. You don't need to go all the way at all times.
- `/annotate-last-message` opens a simple native window where you can write comments to specific parts of the architect's last message
- `/tree` lets you go back and forth in the conversation tree. It's similar to Claude Code's `/btw`, but much, much more powerful. I often use it to explore smaller parts of the conversation, and after having done so, I return to the last "clean" message to clear up context (you can do so with or without generated summaries of your nested conversation).
- `/annotate-git-diff`: similar to `/annotate-last-message`, but for git diffs (even tickets!).
- `/merge-origin-main-into-this-branch`: merges the `origin/main` branch into the current branch.
- `/rebase-this-branch-onto-origin-main`: rebases the current branch onto `origin/main`.

### Product, rush, bug-hunter

These are smaller, laser-focused primary agents. I especially recommend `rush` for quicker fixes that the architect's workflow would be overkill for. `product` handles framing, tradeoffs, strategy, and ticket shaping — it doesn't write code. `bug-hunter` is read-only: reach for it when you want root cause before you've decided how to fix something.

### Disabled mode

`disabled` is a mode where no ad-hoc primary-role guidance is given, but the TLH tooling (subagents, extensions, etc.) is kept. Details are in the [command reference](docs/commands.md#disabled-primary-agent-mode). I would say, frankly, if you find yourself using it a lot: either you should send me feedback to improve TLH, or TLH itself might not be a good fit.

### Optional iPhone companion

The `session-mirror-observer` experimental feature is **off by default**; nothing enables it on install. When you turn it on with `/experimental`, new sessions can mirror bounded TLH session state to a paired iPhone companion. Full behavior and limits are in the [command reference](docs/commands.md#experimental).

TLH never automatically installs or pairs the companion, edits the normal profile, stores a second transcript, or promises background/network behavior. This is an experimental source and deterministic-test boundary, not a claim of fresh physical-device proof; see the [command reference](docs/commands.md) and [companion roadmap](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/companion-roadmap.md) for limits and reported evidence.

## Everything else

### Footer status

The footer refreshes local Git status every 8 seconds. Eligible non-default branches refresh GitHub pull-request metadata at most every 5 minutes; the next refresh after a branch or directory change bypasses that interval. Default branches are skipped, and local upstream tracking is not required. Cached PR data remains visible while a transient lookup fails and is retried on the same cadence.

### Subagents

Subagent orchestration is first-party TLH functionality: the runtime, prompts, and supervision ship in the root package, so there's no separate subagent package to install or pin. Every bundled subagent starts a fresh child session, isolated from the primary agent and from each other, and gets only its task plus explicitly configured instructions. Which roles exist, how dispatch works, what's not supported (like caller-supplied `timeoutMs`), and how status, artifacts, and context diagnostics behave all live in [docs/subagents.md](docs/subagents.md). The imported test suites run in CI but are not published.

Every child instance has a bounded run-time budget per role, owned by the role definition rather than by the model. The actual numbers live in code, so go to [docs/subagents.md](docs/subagents.md#timeout-ownership-and-execution-ceilings) if you want to see how ceilings and overrides work.

You can also add project custom subagents, but only from an exact file at the Git root's `.tlh/agents/custom/` and only after you've persistently `/trust`ed the project. The full rules (and what generic discovery no longer picks up) are in [docs/custom-subagents.md](docs/custom-subagents.md).

Projects can also provide session-scoped model and effort defaults for the packaged primary agents and bundled subagent roles in `.tlh/defaults.json`. Defaults use a separate, weaker configuration-trust decision: persisted `/trust` permits both surfaces, while an upstream/default/session approval permits only `.tlh/defaults.json` and never authorizes or modifies custom agents. See [docs/models.md § Project model/effort defaults](docs/models.md#project-modeleffort-defaults).

The full roster of bundled primaries and minors is in [docs/subagents.md](docs/subagents.md#isolation-and-discovery).

### Direct model providers

TLH treats Anthropic, OpenAI Codex, and xAI as first-class direct providers. Its bundled xAI defaults use Grok 4.6 for primary and higher-reasoning roles and Grok 4.3 for utility roles. For xAI subscription access, use `/login xai` when available; OpenAI defaults intentionally use `openai-codex` for the Codex subscription provider. Anthropic and xAI subscription and API-key authentication share the provider IDs `anthropic` and `xai`, so Pi's stored `/login` credential takes precedence over the corresponding environment key (`ANTHROPIC_API_KEY` or `XAI_API_KEY`). TLH does not select among multiple simultaneous credentials, add auth storage, or mutate user credentials.

### Customisation

You can add your own skills, prompts, extensions, and packages to TLH.

User-level:

- `~/.the-last-harness/agent/skills/`
- `~/.the-last-harness/agent/prompts/`
- `~/.the-last-harness/agent/extensions/` (or via `tlh install github-user/repo`)
- `~/.claude/skills/` — TLH also discovers skills from the Anthropic Claude Code user directory

Repo settings:

- `.pi/skills/`
- `.pi/prompts/`
- `.pi/extensions/`
- `.claude/skills/` — project-level Claude Code skills directory; on the primary agent, **project trust must be granted** before this root is read (see `/trust`)
- `.tlh/agents/custom/<UPPERCASE-SLUG>.md` — direct, Git-root-only project custom-agent definitions; see [Project custom subagents](docs/custom-subagents.md) for the exact contract and persisted-trust requirement.

After adding built-in append files, installing a package, or saving project trust, run `/reload` in TLH (or restart it) so those resources are picked up. Project custom-agent changes become active in a new snapshot after `/reload` or a new session.

#### Per-agent project guidance

To give project-specific instructions to one packaged TLH role, add a plain Markdown prompt append at `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md`, with `<ROLE>` the uppercase role name (e.g. `ARCHITECT_PROMPT_APPEND.md`, `BUG-HUNTER_PROMPT_APPEND.md`). The exact filename for every role is in the [table in docs/custom-subagents.md](docs/custom-subagents.md#canonical-packaged-roles-and-append-files).

For each role, TLH starts at the current working directory and searches upward through the enclosing Git worktree; outside a Git worktree it checks only the current directory. Discovery is exact and non-recursive within each `.tlh/agents/builtin/` directory. The nearest exact match wins. A nearer blank, invalid, or unsafe match does not fall through to a farther same-role file. Only the matching role's append is added to that packaged role's prompt. Legacy `.tlh/<ROLE>.md` paths are no longer read and have no fallback. Files are append-only plain Markdown: they do not replace the packaged prompt, and they do not support YAML frontmatter or model, tool, or other agent configuration. Project custom embedded agents use the separate exact-root contract in [docs/custom-subagents.md](docs/custom-subagents.md), not this convention.

Example:

```sh
mkdir -p .tlh/agents/builtin
cat > .tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md <<'EOF'
Before proposing implementation work, state the important assumptions and risks.
EOF
```

`.tlh/agents/builtin/` is not classified as a trust-requiring resource by the upstream runtime, but the persisted trust entry must contain the selected append source before TLH reads it. In TLH, run `/trust`, choose a persistent `Trust` option (not a session-only option), and save the decision. For a worktree-root append, run `/trust` while TLH is at that worktree root and persist the `Trust` decision there; trust saved only for a nested cwd does not authorize ancestor/worktree-root `.tlh/agents/builtin/` files. Then run `/reload` or restart. Primary-agent appends are snapshotted at session start: edits and newly saved trust take effect for the primary only after that boundary, while switching primary roles selects the corresponding file from the same snapshot. Minor-agent appends are resolved when each child process starts, including awaited, parallel, async, and any resume/revival that launches a new child process. A live async resume/steer that continues the same child process keeps its session-start append snapshot; a resume/revival that starts a new child process rereads the current `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` append.

TLH refuses to read a symlinked `.tlh`, `.tlh/agents`, or `.tlh/agents/builtin` directory or prompt-append file, a non-regular file, or a file larger than **64 KiB**. It fails closed rather than following a symlink, truncating content, or throwing; diagnostics for rejected files are internal and are not guaranteed to be user-visible. Recognized trusted files appear in the expanded startup header under **Project guidance**; rejected files do not appear in startup resources. If prompt appends are found without persisted trust, startup shows an actionable `/trust` plus `/reload` or restart warning without exposing their contents.

To undo the example, remove `.tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md` and run `/reload` or restart; new child launches and resume/revival actions that start a new child process stop using it, while a live async resume/steer that continues an existing child keeps its session-start snapshot. If an ancestor contains another `ARCHITECT_PROMPT_APPEND.md`, it becomes the nearest match, so remove that file too if you want no architect append (or leave an empty nearest file to explicitly shadow farther guidance).

This is separate from the upstream global/project `APPEND_SYSTEM.md` mechanism: the global file in the active isolated profile (by default `~/.the-last-harness/agent/APPEND_SYSTEM.md`) and project `.pi/APPEND_SYSTEM.md` append general system instructions, not role-specific guidance. `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` only adds content to its matching packaged role and does not replace or reconfigure that system prompt.

### Docs dump

- Slash commands reference: [`docs/commands.md`](docs/commands.md)
- First-party subagent dispatch, supervision, migration, and undo steps: [`docs/subagents.md`](docs/subagents.md)
- [Project custom subagents](docs/custom-subagents.md) — exact Git-root layout, persisted trust, and migration/undo rules
- TLH model defaults, thinking levels, and provider selection: [`docs/models.md`](docs/models.md)
- Install, update, uninstall, paths, and undo steps: [`docs/install.md`](docs/install.md)
- Common failure recovery and conservative troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Gnosis, `tk`, and TLH workflow integrations: [`docs/integrations.md`](docs/integrations.md)
- Web search setup, privacy, and opt-out: [`docs/web-search.md`](docs/web-search.md)
- MCP usage, guarded migration, and rollback: [`docs/mcp.md`](docs/mcp.md)
- Launch telemetry and opt-out: [`docs/telemetry.md`](docs/telemetry.md)
- Git commit attribution footer, setting, and toggle flow: [`docs/git-attribution.md`](docs/git-attribution.md)
- Local testing and development: [`docs/local-development.md`](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/local-development.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)
- Maintainer release process: [`docs/releasing.md`](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/releasing.md)

## Third-party attribution

The compact live-progress display shows whimsical thinking phrases while a subagent is reasoning. The phrase pool is adapted from [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff) under the Apache-2.0 license. The full license text is at [`licenses/agent-stuff-Apache-2.0.txt`](licenses/agent-stuff-Apache-2.0.txt).

### Bundled terminal skills

TLH packages three upstream terminal-integration skills from reproducible commit pins. The consolidated license texts and attribution notices for all packaged upstream skills are in [`licenses/terminal-skills.txt`](licenses/terminal-skills.txt).

- **Herdr** — [`herdrdev/herdr`](https://github.com/herdrdev/herdr/tree/b99002ac99b09e00b4ca692436cb15a6b0d676f1/skills/herdr), pinned to commit `b99002ac99b09e00b4ca692436cb15a6b0d676f1` (`herdr v0.9.0`, Apache-2.0). Runtime prerequisite: the `herdr` binary must be on `PATH`, and the agent must be inside a Herdr-managed pane with `HERDR_ENV=1`.
- **cmux CLI** — [`manaflow-ai/cmux-skills`](https://github.com/manaflow-ai/cmux-skills/tree/c669666f8607529a39a1f74ac0e8462e922dd13f/skills/cmux-cli), pinned to commit `c669666f8607529a39a1f74ac0e8462e922dd13f` (MIT). Runtime prerequisite: the `cmux` binary must be on `PATH` and able to reach the cmux app/socket for the requested workflow. Its `scripts/reload.sh` and `scripts/cmux-debug-cli.sh` references are only for a tagged cmux source checkout and are intentionally not part of the packaged runtime closure.
- **tmux** — [`openclaw/openclaw`](https://github.com/openclaw/openclaw/tree/793669c8f6ddfad07b40009068f532832685b7d6/skills/tmux), pinned to commit `793669c8f6ddfad07b40009068f532832685b7d6` (MIT). Runtime prerequisite: `tmux` must be on `PATH`; the upstream skill targets Darwin and Linux, and its helper scripts require Bash and standard `grep`, `date`, and `sleep` utilities.

Only the runtime files directly referenced by these skills are bundled; upstream README files, `AGENTS.md`, and agent metadata are intentionally excluded. The optional related cmux skills named by the upstream guide are source-repository references, not runtime dependencies, and are not bundled.

### Bundled show-me skill

- **show-me** — [`humanlayer/skills`](https://github.com/humanlayer/skills/tree/6ab9013a10c28f5046f7f999549cd5328a0b30d7/plugins/show-me/skills/show-me), pinned to commit `6ab9013a10c28f5046f7f999549cd5328a0b30d7` (MIT).
