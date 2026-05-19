---
id: tlhf-2wzl
status: closed
deps: [tlhf-u5qd]
links: []
created: 2026-05-19T14:55:46Z
type: chore
priority: 2
assignee: Diego Petrucci
---
# Add development-only ESLint

Add ESLint as a repository development tool only: devDependencies, a root flat config, and an npm lint script covering scripts/tests/extensions JS,MJS,TS files. Use recommended correctness-oriented rules without formatting churn. Keep ESLint out of tlh runtime/profile config, installer support manifests, and wrapper behavior. Resolve any lint findings with minimal targeted code changes.

## Design

Prefer ESLint v9 flat config. For TypeScript extension files, use typescript-eslint without type-aware project mode because this repo currently has no tsconfig.json. Do not add Prettier or style-only enforcement.

## Acceptance Criteria

npm run lint passes. ESLint is only in devDependencies/config/scripts and not in TLH default settings, default extensions, installer support manifests, or wrapper runtime behavior. Existing validation commands remain compatible.

