#!/usr/bin/env bash
#
# scripts/upstream-report.sh
#
# ============================================================================
# SIGNAL ONLY — NOT AUTHORITATIVE.
#
# This is a read-only reporting helper. It prints ahead/behind counts vs
# upstream/main, version info, and a `git cherry`/patch-id based heuristic
# signal of which upstream commits look already-applied in the fork. That
# signal can be wrong (squashed, split, or conflict-edited commits will not
# match). It must NEVER be used to mark a commit as adopted or skip ledger
# bookkeeping when adopting any upstream change (fix or feature, cherry-picked
# or reimplemented).
#
# The single source of truth for what has actually been integrated is:
#   - the git DAG (fork's merge/squash-import PR history), and
#   - .upstream-ledger.jsonl (the per-change adoption ledger).
# Any disagreement between this script's output and the ledger/DAG is
# resolved in favor of the ledger/DAG, always.
# Governing policy: AGENTS.md §Fork Sync Policy. docs/UPSTREAM-SYNC.md is
# kept for historical reference only.
#
# This script makes NO repository modifications other than `git fetch
# upstream`. It degrades gracefully (prints a clear message, exits 0) if the
# `upstream` remote is not configured.
#
# Usage:
#   ./scripts/upstream-report.sh
#   npm run upstream:report   (if the npm alias is present)
# ============================================================================

set -u

banner() {
  echo "============================================================"
  echo " upstream-report: SIGNAL ONLY — NOT AUTHORITATIVE"
  echo " Source of truth: git DAG + .upstream-ledger.jsonl"
  echo " (policy: AGENTS.md Fork Sync Policy; UPSTREAM-SYNC.md is historical)"
  echo "============================================================"
}

banner

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git work tree. Aborting." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo
  echo "No 'upstream' remote configured. Skipping report."
  echo "Add it with: git remote add upstream <upstream-repo-url>"
  exit 0
fi

echo
echo "Fetching upstream (git fetch upstream)..."
FETCH_OUTPUT=$(git fetch upstream 2>&1)
FETCH_STATUS=$?
if [ "$FETCH_STATUS" -ne 0 ]; then
  echo "$FETCH_OUTPUT" >&2
  echo "Warning: 'git fetch upstream' exited non-zero (see above, e.g. a" >&2
  echo "conflicting local tag). Continuing with best-effort local refs; the" >&2
  echo "report below may be based on stale data." >&2
fi

if ! git rev-parse --verify upstream/main >/dev/null 2>&1; then
  echo "'upstream/main' is not available locally (fetch never succeeded before" >&2
  echo "and this attempt failed too). Skipping report." >&2
  exit 0
fi

# Use HEAD as the fork ref -- we diff the current working state.
FORK_REF="HEAD"
UPSTREAM_REF="upstream/main"

echo
echo "---- Ahead / behind vs $UPSTREAM_REF ----"
COUNTS=$(git rev-list --left-right --count "${FORK_REF}...${UPSTREAM_REF}" 2>/dev/null)
if [ -n "$COUNTS" ]; then
  AHEAD=$(echo "$COUNTS" | awk '{print $1}')
  BEHIND=$(echo "$COUNTS" | awk '{print $2}')
  echo "Fork ($FORK_REF) is ahead by: $AHEAD commit(s)"
  echo "Fork ($FORK_REF) is behind by: $BEHIND commit(s) (relative to $UPSTREAM_REF)"
else
  echo "Could not compute ahead/behind counts." >&2
fi

echo
echo "---- Versions ----"
if [ -f package.json ]; then
  FORK_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
  echo "Fork package.json version: $FORK_VERSION"
else
  echo "No package.json found in current directory."
fi

LATEST_UPSTREAM_TAG=$(git tag --merged "$UPSTREAM_REF" --sort=-v:refname 2>/dev/null | head -n1)
if [ -z "$LATEST_UPSTREAM_TAG" ]; then
  LATEST_UPSTREAM_TAG=$(git tag --list --sort=-v:refname 2>/dev/null | head -n1)
fi
if [ -n "$LATEST_UPSTREAM_TAG" ]; then
  echo "Latest known upstream-reachable tag: $LATEST_UPSTREAM_TAG"
else
  echo "No tags found to determine latest upstream version."
fi

echo
echo "---- git cherry signal (heuristic, non-authoritative) ----"
echo "Command: git cherry -v $UPSTREAM_REF $FORK_REF"
echo "Lists commits unique to $FORK_REF (fork-only commits, by patch-id) relative"
echo "to $UPSTREAM_REF:"
echo "  '-' = a patch-id-equivalent commit already exists in $UPSTREAM_REF"
echo "        (this fork commit LOOKS already reflected upstream)"
echo "  '+' = no patch-id-equivalent commit found in $UPSTREAM_REF"
echo "        (this fork commit LOOKS not (yet) present upstream)"
echo "This is a patch-id heuristic ONLY and breaks on squash/split/conflict-edits."
echo "This is a heuristic signal only — see AGENTS.md Fork Sync Policy."
echo
CHERRY_OUTPUT=$(git cherry -v "$UPSTREAM_REF" "$FORK_REF" 2>/dev/null)
if [ -n "$CHERRY_OUTPUT" ]; then
  echo "$CHERRY_OUTPUT"
else
  echo "(no differing commits found by git cherry, or comparison unavailable)"
fi

echo
echo "============================================================"
echo " Reminder: this output is SIGNAL ONLY. Do not use it to skip"
echo " ledger bookkeeping when adopting any upstream change. Consult"
echo " .upstream-ledger.jsonl and the git DAG for the authoritative"
echo " record of what has been adopted."
echo "============================================================"
