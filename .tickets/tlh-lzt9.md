---
id: tlh-lzt9
status: closed
deps: []
links: []
created: 2026-05-18T18:51:31Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add context-cap embedding benchmark harness

Create a repeatable benchmark harness for the context-cap embedding experiment. The harness must compare the current npm default-extension path against a temporary treatment package where context-cap is embedded into The Last Harness resources and removed from the default-extension manifest. It must use only temporary agent/bin/cache directories and avoid mutating normal Pi or tlh profiles.

## Design

Use a temporary treatment copy/worktree rather than changing default shipping behavior. For cold-cache runs, use throwaway NPM_CONFIG_CACHE directories instead of clearing the user's npm cache. For warm-cache runs, use a shared temporary cache warmed by the benchmark.

## Acceptance Criteria

Supports 10 runs per variant by default or via --runs. Times control and treatment installs using temp --agent-dir and --bin-dir, with --without-gnosis and --no-wrapper for the isolated extension-install benchmark. Emits machine-readable and human-readable results with the exact commands/env used. Leaves the current checkout and user-owned config/cache untouched.

