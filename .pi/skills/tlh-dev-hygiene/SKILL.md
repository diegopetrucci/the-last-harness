---
name: tlh-dev-hygiene
description: Use when finishing repository development work for The Last Harness before handoff or review. Covers repo-only final hygiene checks and is not for packaged end-user use.
---

# TLH Development Hygiene

Use this repo-local checklist before handing off TLH repository changes.

## Routine validation

- Run one normal `npm run validate` pass for routine local final validation. Do not repeat it or loop `node scripts/run-ci-test-shard.mjs <N>/2` as a local stress ritual.
- CI-shard runs start concurrent lanes and set each lane's `HOME` to a directory under the base `HOME` (`lane-a` and `lane-b`), creating or reusing lane-local caches and state. Avoid repeated local shard loops because they contend for CPU and carry state between runs.
- Run `npm ci` only when the dependency-version check reports missing or stale direct packages and gives that remediation; do not use it as routine setup before validation.
- When a final-validation command fails, `test-runner` reports it and stops. An architect may separately authorize one named-test diagnostic rerun; do not rerun suites or shards without that authorization.

## Checklist

1. Run `git status --short --untracked-files=all` and review the full working tree.
2. Verify there is no repository-root `false` artifact.
3. Confirm every required new file is tracked, and only non-required leftovers are intentionally excluded.
4. Confirm package manifests include any new shipped resources when applicable.
5. Confirm installer support manifests stay aligned when applicable.
6. For installer or package changes, run `npm run validate` or narrower smoke/pack checks that cover the touched paths.
