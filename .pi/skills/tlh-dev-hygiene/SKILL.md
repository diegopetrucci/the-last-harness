---
name: tlh-dev-hygiene
description: Use when finishing repository development work for The Last Harness before handoff or review. Covers repo-only final hygiene checks and is not for packaged end-user use.
---

# TLH Development Hygiene

Use this repo-local checklist before handing off TLH repository changes.

## Checklist

1. Run `git status --short --untracked-files=all` and review the full working tree.
2. Verify there is no repository-root `false` artifact.
3. Confirm every required new file is tracked, and only non-required leftovers are intentionally excluded.
4. Confirm package manifests include any new shipped resources when applicable.
5. Confirm installer support manifests stay aligned when applicable.
6. For installer or package changes, run `npm run validate` or narrower smoke/pack checks that cover the touched paths.
