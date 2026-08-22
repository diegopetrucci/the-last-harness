/* global window */

(function registerReviewStateTransition(global) {
  function clearKeysWithPrefix(record, prefix) {
    for (const key of Object.keys(record)) {
      if (key.startsWith(prefix)) delete record[key];
    }
  }

  function evictCommitState(state, sha) {
    const prefix = `commits:${sha}:`;
    const previousFiles = state.commitFilesBySha[sha] ?? [];
    state.comments = state.comments.filter(
      (comment) => !(comment.scope === "commits" && comment.commitSha === sha),
    );
    for (const file of previousFiles) {
      delete state.reviewedFiles[file.id];
    }
    clearKeysWithPrefix(state.scrollPositions, prefix);
    clearKeysWithPrefix(state.fileContents, prefix);
    clearKeysWithPrefix(state.fileErrors, prefix);
    clearKeysWithPrefix(state.pendingRequestIds, prefix);
    delete state.commitFilesBySha[sha];
    delete state.commitErrors[sha];
    delete state.commitRequestIds[sha];
  }

  function reconcileReviewCommitState(state, previousCommits, nextCommits) {
    const previousBySha = new Map(previousCommits.map((commit) => [commit.sha, commit]));
    const nextBySha = new Map(nextCommits.map((commit) => [commit.sha, commit]));
    const allShas = new Set([...previousBySha.keys(), ...nextBySha.keys()]);

    for (const sha of allShas) {
      const previousCommit = previousBySha.get(sha);
      const nextCommit = nextBySha.get(sha);
      const retainedImmutable =
        previousCommit?.kind !== "working-tree" &&
        nextCommit?.kind !== "working-tree" &&
        previousCommit != null &&
        nextCommit != null;
      if (!retainedImmutable) {
        evictCommitState(state, sha);
        continue;
      }

      delete state.commitErrors[sha];
      clearKeysWithPrefix(state.fileErrors, `commits:${sha}:`);
    }
  }

  global.__reconcileReviewCommitState = reconcileReviewCommitState;
})(typeof window === "undefined" ? globalThis : window);
