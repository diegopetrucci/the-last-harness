---
id: tlhm-rs3v
status: open
deps: []
links: []
created: 2026-05-20T12:23:21Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, ux]
---
# FooterGitCache: surface PR state and pair PR with status's branch (C2, C5)

Two oracle-flagged UX correctness fixes on top of the merged FooterGitCache. Both improve trust in the footer's PR segment. Pair them in one PR because both touch the gh integration path.

## Design

C2 — PR state ignored at the formatter (extensions/the-last-harness/footer-git.mjs::formatPullRequestFooterSegment).
The cache fetches state and isDraft via gh's --json args and stores them in PullRequestSnapshot, but the formatter only branches on number. CLOSED, MERGED, and DRAFT PRs render identically to OPEN. Local branches commonly outlive merged PRs by days, so the footer keeps showing 'PR #42' as if live — erodes trust.

Pick (a) drop the snapshot at cache layer for non-OPEN states, OR (b) suffix the rendered segment with state ('PR #42 merged', 'PR #42 closed', 'PR #42 draft'). (b) is more informative; recommended. Update render tests to cover all four states.

C5 — PR/branch mismatch race (extensions/the-last-harness/footer-git-cache.ts::fetchPullRequest).
gh pr view --json … runs without --branch, so gh resolves the PR from CURRENT HEAD. Between the awaited git status and the awaited gh pr view, the user (or an agent shell tool) can switch branches; the cache then pairs status-for-branch-A with PR-for-branch-B.

Fix: in runRefresh, capture branch from the parsed status and pass it to fetchPullRequest(branch). In fetchPullRequest, append ['--branch', branch] to GH_PR_VIEW_ARGS. No happy-path cost. Add one regression test (mock runner sees the --branch arg with the branch from status).

## Acceptance Criteria

Closed, merged, and draft PRs render distinctly from open PRs (either visible state suffix in the rendered segment, or no PR segment at all for non-OPEN). gh pr view is invoked with --branch <status.branch> so the PR payload is guaranteed to match the captured branch. New render tests cover at least OPEN, CLOSED/MERGED, and DRAFT cases. New cache test asserts fetchPullRequest passes --branch with the value taken from the parsed status (not from current HEAD). Existing tests still pass. No new npm dependencies.

