---
id: tlhf-dw0f
status: open
deps: []
links: []
created: 2026-05-30T08:28:58Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add contributor-only live eval trend reporting

Follow-up from the eval best-practices review for PR #70 / branch add-tlh-eval-suite-score-tracking. The current branch aligns with first-suite best practices by keeping deterministic evals in npm run validate, moving live/model/network evals to repo-only opt-in tooling, using scenario-level scoring, preserving manual rubrics for subjective behavior, and avoiding committed per-run results. The main remaining improvement is contributor-only historical comparison for repeated live eval runs, so maintainers can summarize variance and trends without treating a single nondeterministic live run as definitive. This must stay project/contributor-only and must not become an installed TLH end-user surface.

## Design

Best-practice context: OpenAI and LangSmith emphasize defining good outcomes, task-specific evals, automated scoring where reliable, human judgment for subjective cases, continuous iteration, and avoiding vibe-based evals. Anthropic agent-eval guidance emphasizes trajectories/tool calls, reference solutions or clear rubrics, regression suites, multiple trials for nondeterminism, and calibrated human/model graders. Anthropic statistical guidance recommends not overclaiming from noisy evals; use repeated trials, paired comparisons, standard errors/confidence intervals, or explicit caveats when data is insufficient. For TLH, the initial implementation should likely be a small repo-only script or documented workflow that ingests existing live-eval results files and produces a local summary; statistical calculations can be simple or deferred, but the output must clearly label insufficient sample sizes and avoid committing artifacts.

## Acceptance Criteria

Provide a repo-only way to compare multiple redacted live eval results.json files or result artifacts across repeated runs; report scenario/check-level changes and variance without claiming statistically significant model rankings unless the sample size supports it; document how contributors should run repeated live evals and interpret results; keep default npm run validate deterministic, model-free, and network-free; do not expose the tooling via README user sections, wrapper subcommands, slash commands, packaged prompts/agents/skills, or installed profile behavior; keep per-run results local/ephemeral or CI artifacts and ensure no results.json snapshots are committed; include tests or pack-exclusion checks proving the comparison tooling/docs remain repo-only.

