# The last harness you'll ever need.

[![CI](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/diegopetrucci/the-last-harness/actions/workflows/ci.yml)

`tlh` (The Last Harness) is an isolated, opinionated harness around upstream [Pi](https://github.com/earendil-works/pi). It is built for people who want strong defaults, durable project memory, ticketed execution, and a primary agent that behaves more like a careful technical lead than a fast autocomplete.

It is built around two simple ideas: you can outsource your thinking, but not your understanding ([cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/)); and you should not be babysitting your agents.

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

Common roles include `repo-scout` for discovery, `diff-summarizer` for change overviews, `developer` for implementation, `code-reviewer` for review, `librarian` for repo knowledge, `web-scout` for web research, and `oracle` for a deeper second opinion.

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

- **Rush** is a selectable primary for small bounded implementation tasks. It edits directly, runs narrow validation, and skips the default architect `tk`/developer/review loop. It can still use `code-reviewer` when that extra pass is worth it, and `oracle` is an optional deeper second opinion rather than a default step. Provider defaults are GPT-5.5 with thinking off on OpenAI/OpenAI-Codex, and Anthropic Opus with low thinking on Anthropic.
- **product** is for product framing, tradeoffs, strategy, and implementation-ready ticket shaping. It does not implement code.
- **bug-hunter** is for read-only debugging and root-cause analysis before you decide how to fix something.

Use `Shift+Tab` to cycle the current session through `architect` → `rush` → `product` → `bug-hunter` → `disabled`.

Use `/switch-primary-agent [status|architect|rush|product|bug-hunter|disabled|reset|default architect|default rush|default product|default bug-hunter|default disabled|default reset]` when you want explicit control over the current session or the persistent default.

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

### `/review` is architect-only

The supported shape is bare `/review` in the TLH UI: it opens an interactive picker for **uncommitted**, **branch**, **commit**, **PR**, or **folder** review scopes.

PR review needs the GitHub CLI with `gh auth login`, and TLH only offers the optional `gh pr checkout` branch switch when your working tree is clean and you confirm it. The actual review runs in a fresh isolated `code-reviewer` child session, then the architect returns a digested judgment rather than dumping raw reviewer output.

## What you get beyond the workflow

TLH also aims to make the day-to-day session experience calmer and safer:

- isolated profile installation so your normal Pi setup stays separate,
- quieter UI defaults so tools and bash output do not constantly fight for attention,
- bundled web-search support for research-heavy work,
- bundled MCP adapter support,
- subscription usage footer controls,
- completion notifications, and
- conservative settings merges that preserve user-owned isolated configuration.

The README keeps the overview short on purpose. The detailed operational docs live elsewhere.

## Everything else, aka the docs dump

- Install, update, uninstall, paths, and undo steps: [`docs/install.md`](docs/install.md)
- Gnosis, `tk`, and TLH workflow integrations: [`docs/integrations.md`](docs/integrations.md)
- Web search setup, privacy, and opt-out: [`docs/web-search.md`](docs/web-search.md)
- MCP usage and caveats: [`docs/mcp.md`](docs/mcp.md)
- Local testing and development: [`docs/local-development.md`](docs/local-development.md)
- Release notes: [`CHANGELOG.md`](CHANGELOG.md)
- Maintainer release process: [`docs/releasing.md`](docs/releasing.md)

## Prerequisites

Node.js >=22.19.0 must be available on your `PATH`.

TLH uses upstream Pi >=0.76.0; if `pi` is missing, the installer automatically adds a compatible per-user copy under `~/.local`.
