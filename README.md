# The last harness you'll ever need.

[![CI](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/diegopetrucci/the-last-harness/total)](https://github.com/diegopetrucci/the-last-harness/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-339933?logo=nodedotjs)](package.json)

`tlh` (The Last Harness) is an opinionated harness built on top of [Pi](https://github.com/earendil-works/pi).

Two core ideas drive it:

- _"you can outsource your thinking, but not your understanding"_: LLMs can, and should, provide options, help out with discovery and exploration, filling the gaps in your understanding and technical knowledge — they should not, however, be used as a replacement for understanding. [Beware of cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/).
- _you should not be babysitting your agents_: if you need to manually call tools, run commands, and so on, the harness has failed you.

It achieves this [via a custom orchestration workflow](https://www.stavros.io/posts/how-i-write-software-with-llms/) — you only interface with an architect, whom you engage as a senior peer, and once you're satisfied with the discussion and plan, it takes over until everything is done. Work is pre-reviewed too, often multiple times, so that your time is not wasted in minutiae, freeing you to focus on the bigger picture.

You're also not asked to manually run commands, manage context, or anything like that. This is built-in and done for you. Every further action that you take is because you _want_ to take it, not because you _have_ to. You should not be finding yourself thinking eg "oh, I forgot to trigger `/review`". Your time is worth more.

`tlh` is also slow by default, and relatively token-expensive: it is designed to be used as a long-running, reliable, and predictable tool. You spend time preparing the work, and once it's off, it's off. No babysitting.

If this resonates with you, welcome aboard:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

## Workflows

`tlh` has a few primary workflows/personas: architect, rush, product, bug-hunter, disabled. Each of them has different purpose, encoded with a different system prompt, available tools, and subagents. You can switch between primary agents at any time by pressing `shift` + `tab` — but I would suggest to try not to cross-contaminate the same session (start new ones!).

### The architect

![Illustration of the TLH architect-first workflow: a request passes through approval, tk tickets, scout/build/review child sessions, and returns a judged result.](https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/assets/main-tlh-workflow-illustrations/01-main-tlh-workflow.png)

As a software engineer, you will likely spend most of your time with the **architect** primary agent. The architect does not do any change directly, but its purpose is to help you investigate, find issues, plan the work, and so on. It is banned from making (bigger) direct changes, and it will always propose to encode the plan/work into smaller tickets.

At times, the architect might seem eager to ask you to `approve` the plan. Do not feel afraid to push back and continue exploring and understanding the stakes. This is _your_ work, own it, and explore all possibilities. Also feel free to start new sessions, and treat existing ones as throwaways to get a better idea of what's going on. Rarely one is able to come up with the shape of work on the first try.

The architect has access to a few subagents, which can be divided in three big categories:

- Single-purpose, automatically-invoked ones to keep its context smaller: the librarian to check git repos, web-scout for the internet, etc.
- Core: as the agent does not write code, 1+ developer(s) are tasked to. Same for the reviewer, which avoids you having to run tools like `/review` yourself.
- Optional, second-opinions: the oracle, and the contrarian. The architect might suggest using them, but it will always be up to you whether to actually invoke them.

Notably, the oracle, contrarian, and reviewer prefer an opposite provider for independent second opinions. Anthropic sessions get OpenAI/Codex and OpenAI/Codex sessions get Anthropic; OpenRouter sessions use vendor-aware direct-provider selection with the session model as a retry fallback. See [docs/models.md](docs/models.md) for the full detail.

Again, the core idea: explore and plan with the architect. Double check with the oracle/contrarian. Go back and forth. This is where you, as a human, are required. Once happy, the implementation follows, until ready for your review.

A few quick-fire tips to get the most of the architect:

- If the planned work is too big, ask the architect to delegate even just one tk ticket at a time to the developer. Final-validation tickets go to the command-only test-runner instead. You don't need to go all the way at all times.
- `/annotate-last-message` opens a simple native window where you can write comments to specific parts of the architect's last message
- `/tree` lets you go back and forth in the conversation tree. It's similar to Claude Code's `/btw`, but much, much more powerful. I often use it to explore smaller parts of the conversation, and after having done so, I return to the last "clean" message to clear up context (you can do so with or without generated summaries of your nested conversation).
- `/annotate-git-diff`: similar to `/annotate-last-message`, but for git diffs (even tickets!).
- `/merge-origin-main-into-this-branch`: merges the `origin/main` branch into the current branch.
- `/rebase-this-branch-onto-origin-main`: rebases the current branch onto `origin/main`.

### Product, rush, bug-hunter

These are smaller, laser-focused primary agents. I especially recommend `rush` for quicker fixes that the architect's workflow would be overkill for. `product` handles framing, tradeoffs, strategy, and ticket shaping — it doesn't write code. `bug-hunter` is read-only: reach for it when you want root cause before you've decided how to fix something.

### Disabled mode

`disabled` is a mode where no ad-hoc primary-role guidance is given, but the TLH tooling (subagents, extensions, etc.) is kept. Disabled mode receives no primary-role append, while each newly launched canonical minor agent still uses its own matching project append. It can also initiate an explicitly requested, freshly scoped project custom agent under the exact-root contract. I would say, frankly, if you find yourself using it a lot: either you should send me feedback to improve TLH, or TLH itself might not be a good fit.

## Everything else

### Subagents

Subagent orchestration is first-party TLH functionality: the runtime, prompts, and supervision ship in the root package, so there is no separate subagent package for you to install or pin. The imported test suites live in this repository and run in CI, but are excluded from the published package. TLH ships thirteen packaged roles: four primaries and nine bundled minors. Every bundled subagent starts a fresh child session, isolated from both the primary agent and one another, and receives only its task plus explicitly configured instructions. The reduced model-facing contract supports direct single or parallel execution in the foreground or through TLH-tracked `async: true` background work. `timeoutMs`, `toolBudget`, native `contact_supervisor`, status/lifecycle controls, acceptance evidence, persisted `contextUsage`/`contextPressure` diagnostics, artifacts, model fallback, and migration/undo details are covered in [docs/subagents.md](docs/subagents.md). Caller-supplied `context`, agent `defaultContext`, turn budgets, saved chains, and external pi-intercom detach request/result/control integration are not supported; TLH-tracked async work still uses a detached OS child process managed by TLH, and existing legacy artifacts are left untouched.

Stable, always-available trusted project custom subagents are available to the architect (and `disabled` mode) when an exact file at `<git-worktree-root>/.tlh/agents/custom/<UPPERCASE-SLUG>.md` authorizes them. Custom-agent execution requires a persisted positive `/trust` decision for the validated Git worktree root; session-only or configuration-trust approvals never authorize custom agents. TLH removes generic custom-agent discovery from active-profile `agents/**`, global `~/.agents`, project `.pi/agents/**` and `.agents/**`, configured `subagents.agentDirs`, installed-package/extra-directory definitions, and settings/default overrides (except an active-profile `disabled: true` deny-only tombstone); those definitions do not appear in TLH's custom-agent `list`/`get` or direct-dispatch inventory and cannot create or authorize a custom target. Canonical installer-managed packaged TLH roles continue loading from fixed `<agent-dir>/tlh/agents/subagents/<role>.md` paths; see [docs/custom-subagents.md](docs/custom-subagents.md).

Projects can also provide session-scoped model and effort defaults for the packaged primary agents and bundled subagent roles in `.tlh/defaults.json`. Defaults use a separate, weaker configuration-trust decision: persisted `/trust` permits both surfaces, while an upstream/default/session approval permits only `.tlh/defaults.json` and never authorizes or modifies custom agents. The command-only `test-runner` uses cheap low-effort defaults and can be customized like the other bundled minors through `/subagent-settings` or project defaults. See [docs/models.md § Project model/effort defaults](docs/models.md#project-modeleffort-defaults).

All bundled subagents:

- `repo-scout` for discovery
- `diff-summarizer` for change overviews
- `developer` for implementation and ticket-local validation
- `test-runner` for exact final-validation commands and read-only reports
- `code-reviewer` for review
- `librarian` for read-only GitHub repository research (uses `gh` CLI and `git`)
- `web-scout` for web research
- `oracle` for a deeper second opinion
- `contrarian` as a bundled default minor subagent for sparing adversarial stress-tests

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

To give project-specific instructions to one packaged TLH role, add a plain Markdown prompt append under `.tlh/agents/builtin/` using one of these exact filenames:

| Packaged role     | Exact filename                                         |
| ----------------- | ------------------------------------------------------ |
| `architect`       | `.tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md`       |
| `rush`            | `.tlh/agents/builtin/RUSH_PROMPT_APPEND.md`            |
| `product`         | `.tlh/agents/builtin/PRODUCT_PROMPT_APPEND.md`         |
| `bug-hunter`      | `.tlh/agents/builtin/BUG-HUNTER_PROMPT_APPEND.md`      |
| `developer`       | `.tlh/agents/builtin/DEVELOPER_PROMPT_APPEND.md`       |
| `test-runner`     | `.tlh/agents/builtin/TEST-RUNNER_PROMPT_APPEND.md`     |
| `code-reviewer`   | `.tlh/agents/builtin/CODE-REVIEWER_PROMPT_APPEND.md`   |
| `repo-scout`      | `.tlh/agents/builtin/REPO-SCOUT_PROMPT_APPEND.md`      |
| `diff-summarizer` | `.tlh/agents/builtin/DIFF-SUMMARIZER_PROMPT_APPEND.md` |
| `librarian`       | `.tlh/agents/builtin/LIBRARIAN_PROMPT_APPEND.md`       |
| `web-scout`       | `.tlh/agents/builtin/WEB-SCOUT_PROMPT_APPEND.md`       |
| `oracle`          | `.tlh/agents/builtin/ORACLE_PROMPT_APPEND.md`          |
| `contrarian`      | `.tlh/agents/builtin/CONTRARIAN_PROMPT_APPEND.md`      |

For each role, TLH starts at the current working directory and searches upward through the enclosing Git worktree; outside a Git worktree it checks only the current directory. Discovery is exact and non-recursive within each `.tlh/agents/builtin/` directory. The nearest exact match wins. A nearer blank, invalid, or unsafe match does not fall through to a farther same-role file. Only the matching role's append is added to that packaged role's prompt. Legacy `.tlh/<ROLE>.md` paths are no longer read and have no fallback. Files are append-only plain Markdown: they do not replace the packaged prompt, and they do not support YAML frontmatter or model, tool, or other agent configuration. Project custom embedded agents use the separate exact-root contract in [docs/custom-subagents.md](docs/custom-subagents.md), not this convention.

Example:

```sh
mkdir -p .tlh/agents/builtin
cat > .tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md <<'EOF'
Before proposing implementation work, state the important assumptions and risks.
EOF
```

`.tlh/agents/builtin/` is not classified as a trust-requiring resource by the upstream runtime, but the persisted trust entry must contain the selected append source before TLH reads it. In TLH, run `/trust`, choose a persistent `Trust` option (not a session-only option), and save the decision. For a worktree-root append, run `/trust` while TLH is at that worktree root and persist the `Trust` decision there; trust saved only for a nested cwd does not authorize ancestor/worktree-root `.tlh/agents/builtin/` files. Then run `/reload` or restart. Primary-agent appends are snapshotted at session start: edits and newly saved trust take effect for the primary only after that boundary, while switching primary roles selects the corresponding file from the same snapshot. Minor-agent appends are resolved when each child process starts, including foreground, parallel, async, and any resume/revival that launches a new child process. A live async resume/steer that continues the same child process keeps its session-start append snapshot; a resume/revival that starts a new child process rereads the current `.tlh/agents/builtin/<ROLE>_PROMPT_APPEND.md` append.

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
- MCP usage and caveats: [`docs/mcp.md`](docs/mcp.md)
- Launch telemetry and opt-out: [`docs/telemetry.md`](docs/telemetry.md)
- Git commit attribution footer, setting, and toggle flow: [`docs/git-attribution.md`](docs/git-attribution.md)
- Local testing and development: [`docs/local-development.md`](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/local-development.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)
- Maintainer release process: [`docs/releasing.md`](https://github.com/diegopetrucci/the-last-harness/blob/main/docs/releasing.md)
