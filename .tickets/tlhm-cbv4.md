---
id: tlhm-cbv4
status: open
deps: []
links: []
created: 2026-06-27T19:50:52Z
type: feature
priority: 1
assignee: Diego Petrucci
---
# Lazy-load command-only self-package modules to cut launch time

The TLH self-package entry (extensions/the-last-harness.ts) statically imports ~30 submodules at top level, so Pi/jiti transpiles and evaluates all of them at startup even when unused. Convert the heavy, genuinely command-only modules to lazy loading: register the slash command synchronously at load, but defer importing the handler body via dynamic import() inside the command callback, so the module is only transpiled+evaluated the first time the command runs. Confirmed safe and idiomatic for Pi (async command handlers; Pi itself lazy-loads provider SDKs for startup) -- see gnosis njekqj and Pi issue #4704.

## Design

Scope to modules reachable ONLY via command registration (verified by import-graph inspection): review.ts (~35K) and tokens.ts (which pulls tokens-analyzer.ts; ~58K combined). Optionally the small changelog.ts and effort.ts. DO NOT lazy-load attribution.ts, experimental.ts, subscription-usage.ts, usage-limits.ts -- they are also imported by startup paths (primary-agent-runtime.ts / footer), so deferring only their command import saves nothing without a separate module split (out of scope). Pattern: drop the top-level `import { registerXCommand } from "./the-last-harness/x.js"`; register the command synchronously with a thin wrapper whose handler does `const mod = await import("./the-last-harness/x.js")` then delegates. Keep ".js" specifiers (jiti resolves .js->.ts). Preserve synchronous registration metadata (name, description, argument completions) at load time so command discovery/autocomplete is unaffected. Add tests that invoke each lazified command end-to-end so a broken deferred import fails in CI, not silently at command-time.

## Acceptance Criteria

Each lazified command (/review, /tokens, plus any others changed) still works end-to-end; the deferred modules are NOT evaluated during extension load (verify via measurement or a load-time probe); warm startup is not regressed (ideally improved); command discovery/autocomplete metadata unchanged; new tests cover invoking each lazified command; typecheck/node --check and ticket-scoped tests pass. Defer full `npm run validate` + startup measurement to the final-validation ticket.

