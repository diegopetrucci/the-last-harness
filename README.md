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

- If the planned work is too big, ask the architect to delegate even just one tk ticket at a time to the developer. You don't need to go all the way at all times.
- `/annotate-last-message` opens a simple native window where you can write comments to specific parts of the architect's last message
- `/tree` lets you go back and forth in the conversation tree. It's similar to Claude Code's `/btw`, but much, much more powerful. I often use it to explore smaller parts of the conversation, and after having done so, I return to the last "clean" message to clear up context (you can do so with or without generated summaries of your nested conversation).
- `/annotate-git-diff`: similar to `/annotate-last-message`, but for git diffs (even tickets!).
- `/merge-origin-main-into-this-branch`: merges the `origin/main` branch into the current branch.
- `/rebase-this-branch-onto-origin-main`: rebases the current branch onto `origin/main`.

### Product, rush, bug-hunter

These are smaller, laser-focused primary agents. I especially recommend `rush` for quicker fixes that the architect's workflow would be overkill for. `product` handles framing, tradeoffs, strategy, and ticket shaping — it doesn't write code. `bug-hunter` is read-only: reach for it when you want root cause before you've decided how to fix something.

## Everything else

### Subagents

Subagent orchestration is first-party TLH functionality: the runtime, prompts, and supervision ship in the root package, so there is no separate subagent package for you to install or pin. The imported test suites live in this repository and run in CI, but are excluded from the published package. Bundled subagents start in a fresh context, isolated from both the primary agent and one another, and the primary gives them just enough context to do their job. Async work, status/steering, durable pause/resume, acceptance evidence, diagnostics, artifacts, and the full migration/undo details are covered in [docs/subagents.md](docs/subagents.md).

User-owned embedded subagents are supported behind the default-off `embedded-subagents` experimental flag; see [docs/embedded-subagents.md](docs/embedded-subagents.md).

All bundled subagents:

- `repo-scout` for discovery
- `diff-summarizer` for change overviews
- `developer` for implementation
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

After adding files, installing a package, or saving project trust, run `/reload` in TLH (or restart it) so the new resources are picked up.

#### Per-agent project guidance

To give project-specific instructions to one packaged TLH role, add plain Markdown under `.tlh/` using one of these exact filenames:

| Packaged role     | Exact filename            |
| ----------------- | ------------------------- |
| `architect`       | `.tlh/ARCHITECT.md`       |
| `rush`            | `.tlh/RUSH.md`            |
| `product`         | `.tlh/PRODUCT.md`         |
| `bug-hunter`      | `.tlh/BUG-HUNTER.md`      |
| `developer`       | `.tlh/DEVELOPER.md`       |
| `code-reviewer`   | `.tlh/CODE-REVIEWER.md`   |
| `repo-scout`      | `.tlh/REPO-SCOUT.md`      |
| `diff-summarizer` | `.tlh/DIFF-SUMMARIZER.md` |
| `librarian`       | `.tlh/LIBRARIAN.md`       |
| `web-scout`       | `.tlh/WEB-SCOUT.md`       |
| `oracle`          | `.tlh/ORACLE.md`          |
| `contrarian`      | `.tlh/CONTRARIAN.md`      |

For each role, TLH starts at the current working directory and searches upward through the enclosing Git worktree; outside a Git worktree it checks only the current directory. The nearest exact match wins. A nearer blank, invalid, or unsafe match does not fall through to a farther same-role file. Only the matching role's file is appended to that packaged role's prompt. Files are append-only plain Markdown: they do not replace the packaged prompt, and they do not support YAML frontmatter or model, tool, or other agent configuration. Embedded agents and other custom agents are not supported by this convention.

Example:

```sh
mkdir -p .tlh
cat > .tlh/ARCHITECT.md <<'EOF'
Before proposing implementation work, state the important assumptions and risks.
EOF
```

`.tlh` is not classified as a trust-requiring resource by the upstream runtime, but the persisted trust entry must contain the selected guidance source before TLH reads it. In TLH, run `/trust`, choose a persistent `Trust` option (not a session-only option), and save the decision. For a worktree-root file, run `/trust` while TLH is at that worktree root and persist the `Trust` decision there; trust saved only for a nested cwd does not authorize ancestor/worktree-root `.tlh` files. Then run `/reload` or restart. Primary-agent guidance is snapshotted at session start: edits and newly saved trust take effect for the primary only after that boundary, while switching primary roles selects the corresponding file from the same snapshot. Minor-agent guidance is resolved when each child process starts, including foreground, parallel, async, and any resume/revival that launches a new child process. A live async resume/steer that continues the same child process keeps its session-start guidance snapshot; a resume/revival that starts a new child process rereads the current `.tlh/<ROLE>.md` guidance.

TLH refuses to read a symlinked `.tlh` directory or role file, a non-regular file, or a file larger than **64 KiB**. It fails closed rather than following a symlink, truncating content, or throwing; diagnostics for rejected files are internal and are not guaranteed to be user-visible. Recognized trusted files appear in the expanded startup header under **Project guidance**; rejected files do not appear in startup resources. If role files are found without persisted trust, startup shows an actionable `/trust` plus `/reload` or restart warning without exposing their contents.

To undo the example, remove `.tlh/ARCHITECT.md` and run `/reload` or restart; new child launches and resume/revival actions that start a new child process stop using it, while a live async resume/steer that continues an existing child keeps its session-start snapshot. If an ancestor contains another `ARCHITECT.md`, it becomes the nearest match, so remove that file too if you want no architect guidance (or leave an empty nearest file to explicitly shadow farther guidance).

This is separate from the upstream global/project `APPEND_SYSTEM.md` mechanism: the global file in the active isolated profile (by default `~/.the-last-harness/agent/APPEND_SYSTEM.md`) and project `.pi/APPEND_SYSTEM.md` append general system instructions, not role-specific guidance. `.tlh/<ROLE>.md` only adds content to its matching packaged role and does not replace or reconfigure that system prompt.

### Docs dump

- Slash commands reference: [`docs/commands.md`](docs/commands.md)
- First-party subagent dispatch, supervision, migration, and undo steps: [`docs/subagents.md`](docs/subagents.md)
- User-owned trusted embedded subagents: [`docs/embedded-subagents.md`](docs/embedded-subagents.md)
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
