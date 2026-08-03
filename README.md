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

![Illustration of the TLH architect-first workflow: a request passes through approval, tk tickets, scout/build/review child sessions, and returns a judged result.](assets/main-tlh-workflow-illustrations/01-main-tlh-workflow.png)

As a software engineer, you will likely spend most of your time with the **architect** primary agent. The architect does not do any change directly, but its purpose is to help you investigate, find issues, plan the work, and so on. It is banned from making (bigger) direct changes, and it will always propose to encode the plan/work into smaller tickets.

At times, the architect might seem eager to ask you to `approve` the plan. Do not feel afraid to push back and continue exploring and understanding the stakes. This is _your_ work, own it, and explore all possibilities. Also feel free to start new sessions, and treat existing ones as throwaways to get a better idea of what's going on. Rarely one is able to come up with the shape of work on the first try.

The architect has access to a few subagents, which can be divided in three big categories:

- Single-purpose, automatically-invoked ones to keep its context smaller: the librarian to check git repos, web-scout for the internet, etc.
- Core: as the agent does not write code, 1+ developer(s) are tasked to. Same for the reviewer, which avoids you having to run tools like `/review` yourself.
- Optional, second-opinions: the oracle, and the contrarian. The architect might suggest using them, but it will always be up to you whether to actually invoke them.

Notably, the oracle, contrarian, and reviewer all run on the opposite provider from your active session — Anthropic primary sessions get OpenAI, and OpenAI/Codex primary sessions get Anthropic — so that their second opinion truly is a second opinion, and not just Claude with a moustache and shades. See [docs/models.md](docs/models.md) for the full detail.

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

All subagents exist in a fresh context, isolated from both the primary agent and other subagents. This is to avoid cross-contamination. The primary agent provides them just enough context to do their job.

User-owned embedded subagents are supported behind the default-off `embedded-subagents` experimental flag; see [docs/embedded-subagents.md](docs/embedded-subagents.md).

All bundled subagents:

- `repo-scout` for discovery
- `diff-summarizer` for change overviews
- `developer` for implementation
- `code-reviewer` for review
- `librarian` for read-only GitHub repository research (uses `gh` CLI and `git`)
- `web-scout` for web research
- `oracle` for a deeper second opinion
- `contrarian` as a bundled default minor subagent for sparing adversarial stress-tests.

### Customisation

You can add your own skills, prompts, extensions, and packages to TLH.

User-level:
- `~/.the-last-harness/agent/skills/`
- `~/.the-last-harness/agent/prompts/`
- `~/.the-last-harness/agent/extensions/` (or via `tlh install github-user/repo`)

Repo settings:
- `.pi/skills/`
- `.pi/prompts/`
- `.pi/extensions/`

After adding files, installing a package, or saving project trust, run `/reload` in TLH (or restart it) so the new resources are picked up.

### Docs dump

- Slash commands reference: [`docs/commands.md`](docs/commands.md)
- TLH model defaults, thinking levels, and provider selection: [`docs/models.md`](docs/models.md)
- Install, update, uninstall, paths, and undo steps: [`docs/install.md`](docs/install.md)
- Common failure recovery and conservative troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Gnosis, `tk`, and TLH workflow integrations: [`docs/integrations.md`](docs/integrations.md)
- Web search setup, privacy, and opt-out: [`docs/web-search.md`](docs/web-search.md)
- MCP usage and caveats: [`docs/mcp.md`](docs/mcp.md)
- Launch telemetry and opt-out: [`docs/telemetry.md`](docs/telemetry.md)
- Git commit attribution footer, setting, and toggle flow: [`docs/git-attribution.md`](docs/git-attribution.md)
- Local testing and development: [`docs/local-development.md`](docs/local-development.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)
- Maintainer release process: [`docs/releasing.md`](docs/releasing.md)
- Accepted dependency risks: [`docs/dependency-risk.md`](docs/dependency-risk.md)
