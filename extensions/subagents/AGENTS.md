# Subagents Extension Guidelines

Scope: `extensions/subagents/`, the first-party subagent runtime. Repository-wide rules live in the root [AGENTS.md](../../AGENTS.md); validation in [VALIDATING.md](../../VALIDATING.md); runtime behavior in [docs/subagents.md](../../docs/subagents.md). This file only adds what is specific to this subtree.

## Source and generated files

- `src/**/*.ts` is authoritative. Same-layout `src/**/*.js` files are generated and carry a `// Generated from ...` header.
- Edit the `.ts` file, then run `npm run build` from the repo root. Never hand-edit a `.js` twin.

## Tests

- `test/unit/`, `test/integration/`, `test/e2e/`: suites by scope; `test/support/`: shared helpers and the loader (`register-loader.mjs`).
- Suite commands, single-file runs, and focused diagnostics are in [VALIDATING.md](../../VALIDATING.md#test-suites-and-output-modes) and its "Fast checks for agents" section.
- `test/` is excluded from the npm package via this directory's `.npmignore`; keep it that way.

## Packaging and licensing

- This `AGENTS.md` is also excluded from publication through `.npmignore`.
- `LICENSE` carries the upstream MIT notice for the imported code; keep it in place.
