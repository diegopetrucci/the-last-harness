# The last harness you'll ever need.

[![CI](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml)
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

## The default TLH workflow: architect first

Most TLH users stay with the **architect** primary agent.

The architect is the default because TLH is optimized for a deliberate loop:

1. clarify the request until the goal and constraints are explicit,
2. inspect the repo and relevant context,
3. propose a plan,
4. wait for the exact word `approved`,
5. create scoped `tk` tickets,
6. delegate implementation and review to focused minor subagents,
7. evaluate those results critically, and
8. report back with judgment and accountability.

That last part matters: the architect does not disappear once work is delegated. It stays responsible for orchestration, pushes back on weak subagent output, decides what to do next, and remains the single point of accountability to the user.

### Minor subagents are focused child sessions

TLH subagents are fresh child sessions, not a giant shared swarm. They get the task and project context they need, not the whole primary conversation. In practice that means less context pollution, clearer responsibilities, and easier review of what each agent was asked to do.

- `repo-scout` for discovery
- `diff-summarizer` for change overviews
- `developer` for implementation
- `code-reviewer` for review
- `librarian` for repo knowledge
- `web-scout` for web research
- `oracle` for a deeper second opinion.

For review independence, `code-reviewer` intentionally prefers an available opposite provider. Anthropic sessions try to use the OpenAI Codex subscription provider for review when it is available, while OpenAI/OpenAI-Codex sessions try Anthropic review when it is available. If you only have regular OpenAI API access and not the Codex subscription provider, TLH does not force `code-reviewer` onto unavailable Codex-only defaults.

## Why this workflow is useful

### Benefits

- **Better scoping before edits**: the default path favors understanding before action.
- **Cleaner accountability**: one architect owns the loop even when multiple child sessions contribute.
- **Durable decisions**: memory and tickets make important context easier to revisit later.
- **Fresh execution contexts**: focused child sessions reduce drift from long, messy chats.
- **Reviewable work**: implementation is broken into explicit, inspectable steps instead of one giant conversation blob.

### Tradeoffs

- **More process**: TLH is intentionally slower than “just start coding.”
- **More opinionated**: if you dislike tickets, memory, or explicit approval gates, the defaults may feel heavy.
- **Not ideal for every task**: tiny changes may not need the full architect loop.
- **Extra tooling**: TLH expects supporting CLIs and repo-local artifacts that some users would rather avoid.

If you want a harness that stays out of your way, TLH may be too structured. If you want a harness that helps you avoid vague plans, lost context, and agent babysitting, that structure is the point.

## Other primary agents

The architect is the default, but it is not the only mode.

- **Rush** is a selectable primary for small bounded implementation tasks. It edits directly, runs narrow validation, and skips the default architect `tk`/developer/review loop. It can still use `code-reviewer` when that extra pass is worth it, and `oracle` is an optional deeper second opinion rather than a default step. Provider defaults are GPT-5.5 with thinking off on the OpenAI Codex subscription provider, and Anthropic Opus with low thinking on Anthropic.
- **Product** is for product framing, tradeoffs, strategy, and implementation-ready ticket shaping. It does not implement code.
- **Bug-hunter** is for read-only debugging and root-cause analysis before you decide how to fix something.

Use `Shift+Tab` to cycle the current session through `architect` → `rush` → `product` → `bug-hunter` → `disabled`.

When primary agents are disabled, TLH stops applying those primary-agent workflow/persona rules, but the underlying subagent machinery still exists.

## TLH is intentionally opinionated

TLH is not just “Pi, but with a new prompt.” The harness bakes in workflow and UX opinions:

- **Project memory is mandatory**: TLH requires Gnosis (`gn`) so decisions, constraints, rejected alternatives, and lessons can live in repo-local memory instead of disappearing into chat history.
- **Ticketed execution is mandatory for architect/product flows**: TLH requires `tk` for dependency-tracked tickets and installs the managed command at `~/.the-last-harness/agent/bin/tk` when it needs to supply one. Rush is the main exception for very small direct-edit tasks.
- **Context is capped on purpose**: TLH uses a 200k context cap, expects compaction instead of endless chat growth, and provides `/context` so you can inspect where your tokens are going.
- **Fresh child contexts are the default**: child sessions start clean and focused rather than inheriting an entire messy parent transcript.
- **Model defaults are role-aware**: TLH ships bundled per-role model/thinking defaults instead of expecting every user to tune everything manually.
- **Safety and quiet-by-default UX matter**: destructive-action confirmations, quieter tool rendering, trimmed footer noise, usage-window visibility, notifications when turns finish, and dirty-repo prompts are part of the package.
- **Useful integrations are already wired in**: web research and MCP support are part of the default story rather than an afterthought.

## What you get beyond the workflow

TLH also aims to make the day-to-day session experience calmer and safer:

- isolated profile installation so your normal Pi setup stays separate,
- quieter UI defaults so tools and bash output do not constantly fight for attention,
- a lightweight first-party `/annotate-last-message` command that opens a native annotation window for the latest assistant reply and turns submitted notes into agent feedback,
- a first-party `/annotate-git-diff` command that opens a native review window and pastes submitted feedback back into the editor as a prompt,
- bundled web-search support for research-heavy work,
- bundled MCP adapter support,
- subscription usage footer controls,
- completion notifications, and
- conservative settings merges that preserve user-owned isolated configuration.

## Add your own skills, extensions, etc

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

Normal `tlh update` runs are conservative: they preserve user-owned isolated-profile resources instead of overwriting them, and they still do not touch your normal Pi config.

## Everything else, aka the docs dump

- Slash commands reference: [`docs/commands.md`](docs/commands.md)
- Install, update, uninstall, paths, and undo steps: [`docs/install.md`](docs/install.md)
- Gnosis, `tk`, and TLH workflow integrations: [`docs/integrations.md`](docs/integrations.md)
- Web search setup, privacy, and opt-out: [`docs/web-search.md`](docs/web-search.md)
- MCP usage and caveats: [`docs/mcp.md`](docs/mcp.md)
- Launch telemetry and opt-out: [`docs/telemetry.md`](docs/telemetry.md)
- Git commit attribution footer, setting, and toggle flow: [`docs/git-attribution.md`](docs/git-attribution.md)
- Local testing and development: [`docs/local-development.md`](docs/local-development.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)
- Maintainer release process: [`docs/releasing.md`](docs/releasing.md)

## Prerequisites

Node.js >=22.19.0 must be available on your `PATH`.

TLH uses upstream Pi >=0.79.1; if `pi` is missing, the installer automatically adds a compatible per-user copy under `~/.local`.
