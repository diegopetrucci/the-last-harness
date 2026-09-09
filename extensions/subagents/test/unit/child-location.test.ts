/**
 * Unit tests for the child-location snapshot helper.
 *
 * All git invocations are exercised through the injectable GitRunner seam so
 * tests never shell out to git and the suite remains hermetic.
 *
 * Key semantic: GitRunner.processError is true ONLY for OS-level failures
 * (binary missing, timeout, bad cwd). A nonzero git exit code (not a repo,
 * unborn HEAD, etc.) is NOT a process error: git ran and gave its own answer.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  captureChildLocationSnapshot,
  makeParentGitFactsAccessor,
  type GitRunner,
} from "../../src/shared/child-location.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockResponse = {
  stdout: string;
  processError: boolean;
  exitStatus: number | null;
  stderr: string;
};

/** Build a GitRunner stub that returns canned per-cwd responses. */
function makeGitRunner(responses: Map<string, MockResponse>): {
  runner: GitRunner;
  state: { callCount: number; calledWith: string[] };
} {
  const state = { callCount: 0, calledWith: [] as string[] };
  const runner: GitRunner = (normalizedCwd) => {
    state.callCount++;
    state.calledWith.push(normalizedCwd);
    const response = responses.get(normalizedCwd);
    if (response === undefined) {
      // Path not in map: simulate OS-level failure (process error) so callers
      // treat it as indeterminate rather than "not a git repo".
      return { stdout: "", processError: true, exitStatus: null, stderr: "" };
    }
    return response;
  };
  return { runner, state };
}

/**
 * Build canonical git rev-parse stdout for a cwd, matching the argument order:
 *   git rev-parse --show-toplevel --git-common-dir HEAD --abbrev-ref HEAD
 *
 * Lines: toplevel, commonDir, fullSha (40 chars), abbrevRef.
 * The production parser derives a 7-char shortSha from fullSha[:7].
 */
function gitOutput(opts: {
  toplevel: string;
  commonDir: string;
  abbrevRef: string;
  /** Full 40-character SHA; the parser derives the short SHA from the first 7 chars. */
  fullSha: string;
}): string {
  return [opts.toplevel, opts.commonDir, opts.fullSha, opts.abbrevRef].join("\n") + "\n";
}

/** Convenience: build a no-error MockResponse for a happy-path git output. */
function okResponse(opts: {
  toplevel: string;
  commonDir: string;
  abbrevRef: string;
  fullSha: string;
}): MockResponse {
  return { stdout: gitOutput(opts), processError: false, exitStatus: 0, stderr: "" };
}

/** Convenience: build a MockResponse for a process-level error (e.g. git not found). */
function processErrorResponse(): MockResponse {
  return { stdout: "", processError: true, exitStatus: null, stderr: "" };
}

/** Convenience: build a MockResponse for "not a git repository" (exit 128 + canonical stderr). */
function notARepoResponse(): MockResponse {
  return {
    stdout: "",
    processError: false,
    exitStatus: 128,
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
  };
}

/** Partial git output (e.g. unborn repo: toplevel and commonDir present, no branch/sha). */
function gitOutputPartial(opts: { toplevel: string; commonDir: string }): string {
  return [opts.toplevel, opts.commonDir].join("\n") + "\n";
}

// Fixed paths used across tests; chosen to be clearly different from any real
// path so there is no risk of accidental collision.
const PARENT_CWD = path.join(os.tmpdir(), "tlh-test-parent");
const CHILD_SAME = PARENT_CWD;
const CHILD_SUBDIR = path.join(PARENT_CWD, "src", "lib");
const CHILD_OTHER_REPO = path.join(os.tmpdir(), "tlh-test-other-repo");
const CHILD_WORKTREE = path.join(os.tmpdir(), "tlh-test-worktree");
const CHILD_NO_GIT = path.join(os.tmpdir(), "tlh-test-no-git");
const CHILD_DETACHED = path.join(os.tmpdir(), "tlh-test-detached");
const CHILD_UNBORN = path.join(os.tmpdir(), "tlh-test-unborn");

const PARENT_COMMON_DIR = path.join(PARENT_CWD, ".git");
const OTHER_COMMON_DIR = path.join(CHILD_OTHER_REPO, ".git");

// A linked worktree shares the same git-common-dir as the main worktree but
// has a different toplevel.
const SHARED_COMMON_DIR = path.join(PARENT_CWD, ".git");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("captureChildLocationSnapshot", () => {
  it("returns undefined and invokes git zero times when child cwd equals parent cwd", () => {
    const { runner, state } = makeGitRunner(new Map());
    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_SAME, runner);

    assert.equal(result, undefined);
    assert.equal(state.callCount, 0);
  });

  it("returns undefined and invokes git zero times even when paths differ only in trailing slash", () => {
    const { runner, state } = makeGitRunner(new Map());
    const childWithSlash = PARENT_CWD + path.sep;
    // path.resolve strips trailing separators, so normalized paths match.
    const result = captureChildLocationSnapshot(PARENT_CWD, childWithSlash, runner);

    assert.equal(result, undefined);
    assert.equal(state.callCount, 0);
  });

  it("returns a snapshot with a relative displayPath when child is inside parent", () => {
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_SUBDIR,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner, state } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_SUBDIR, runner);

    assert.ok(result !== undefined);
    assert.equal(result.childCwd, CHILD_SUBDIR);
    assert.equal(result.displayPath, path.join("src", "lib"));
    // Same branch and same repo — no extra fields.
    assert.equal(result.branch, undefined);
    assert.equal(result.detachedHead, undefined);
    assert.equal(result.repoName, undefined);
    assert.equal(result.linkedWorktree, undefined);
    assert.equal(result.notAGitRepo, undefined);
    assert.equal(state.callCount, 2);
  });

  it("sets repoName to the basename of the child toplevel when child is in a different repository", () => {
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "feature",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner, state } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    assert.ok(result !== undefined);
    // repoName must be a short display name, not an absolute path.
    assert.equal(result.repoName, path.basename(CHILD_OTHER_REPO));
    assert.ok(
      !result.repoName?.includes(path.sep),
      `repoName should not contain a path separator, got: ${result.repoName}`,
    );
    // Different branch in the different repo.
    assert.equal(result.branch, "feature");
    assert.equal(result.linkedWorktree, undefined);
    assert.equal(result.notAGitRepo, undefined);
    assert.equal(state.callCount, 2);
  });

  it("sets linkedWorktree when child is a linked worktree of the same repository", () => {
    const worktreeCommonDir = SHARED_COMMON_DIR; // same as parent
    const worktreeToplevel = CHILD_WORKTREE; // different toplevel

    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: SHARED_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_WORKTREE,
        okResponse({
          toplevel: worktreeToplevel,
          commonDir: worktreeCommonDir,
          abbrevRef: "feature-wt",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_WORKTREE, runner);

    assert.ok(result !== undefined);
    assert.equal(result.linkedWorktree, true);
    assert.equal(result.repoName, undefined);
    // Branch differs → should be included.
    assert.equal(result.branch, "feature-wt");
    assert.equal(result.notAGitRepo, undefined);
  });

  it("sets notAGitRepo on positive evidence: exit 128 + 'not a git repository' in stderr", () => {
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      // Positive evidence: git ran (no process error), exited 128, canonical stderr.
      [CHILD_NO_GIT, notARepoResponse()],
    ]);
    const { runner, state } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_NO_GIT, runner);

    assert.ok(result !== undefined);
    assert.equal(result.notAGitRepo, true);
    assert.equal(result.branch, undefined);
    assert.equal(result.detachedHead, undefined);
    assert.equal(result.repoName, undefined);
    assert.equal(result.linkedWorktree, undefined);
    assert.equal(state.callCount, 2);
  });

  it("does NOT set notAGitRepo when child git lookup is a process error (binary missing, timeout, bad cwd)", () => {
    // This is the indeterminate case: we can't distinguish "not a repo" from
    // "git is unavailable". We must not assert something false.
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      // Process error: git could not be run (e.g. binary missing, timeout).
      [CHILD_NO_GIT, processErrorResponse()],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_NO_GIT, runner);

    assert.ok(result !== undefined, "snapshot must still be returned (cwd: is always shown)");
    assert.equal(result.notAGitRepo, undefined, "must NOT claim 'not a repo' on process error");
    assert.equal(result.branch, undefined);
    assert.equal(result.repoName, undefined);
    // displayPath is still populated (it's derived from cwd, not git).
    assert.ok(result.displayPath.length > 0, "displayPath must be set regardless of git failure");
  });

  it("does NOT set notAGitRepo when parent git lookup reports a process error even if stdout yielded a toplevel (timeout/truncated read)", () => {
    // spawnSync can return partial stdout on timeout: the toplevel line may
    // have been written before the process was killed, so parentGit.toplevel
    // is non-undefined while processError is true.
    // The old guard required only parentGit.toplevel !== undefined, which
    // would accept this partial read as positive evidence. The tightened guard
    // requires !parentGit.processError && exitStatus === 0 as well.
    const parentToplevelLine = PARENT_CWD + "\n"; // partial stdout, only toplevel was written
    const responses = new Map([
      [
        PARENT_CWD,
        {
          stdout: parentToplevelLine,
          processError: true, // OS-level failure (e.g. timeout); partial stdout retained
          exitStatus: null,
          stderr: "",
        },
      ],
      // Child positively has no git repo.
      [CHILD_NO_GIT, notARepoResponse()],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_NO_GIT, runner);

    assert.ok(result !== undefined, "snapshot must still be returned");
    assert.equal(
      result.notAGitRepo,
      undefined,
      "must NOT set notAGitRepo when parent lookup had a process error, even if toplevel was partially read",
    );
    assert.equal(result.branch, undefined);
    assert.equal(result.repoName, undefined);
    assert.ok(result.displayPath.length > 0, "displayPath must be set");
  });

  it("treats an unborn repo (partial stdout, nonzero exit) as having a toplevel but no branch", () => {
    // Simulates `git init` with no commits: --show-toplevel and --git-common-dir
    // are emitted but HEAD and --abbrev-ref HEAD fail (no HEAD).
    // git exits nonzero but this is NOT a process error.
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_UNBORN,
        {
          // Partial output: toplevel and commonDir only (no SHA, no branch).
          stdout: gitOutputPartial({ toplevel: CHILD_UNBORN, commonDir: CHILD_UNBORN + "/.git" }),
          processError: false,
          // git exits 128 for unborn HEAD, but the message is NOT "not a git repository".
          exitStatus: 128,
          stderr:
            "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
        },
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_UNBORN, runner);

    assert.ok(result !== undefined, "snapshot must be returned for unborn repo");
    // The unborn repo IS a git repo — do not flag it as notAGitRepo.
    assert.equal(result.notAGitRepo, undefined, "unborn repo must NOT be flagged as not a repo");
    // No branch info available (unborn HEAD), so branch should be absent.
    assert.equal(result.branch, undefined);
    assert.equal(result.detachedHead, undefined);
    // It's in a different repo from PARENT_CWD (different common-dir).
    assert.ok(
      result.repoName !== undefined,
      "repoName should be set for different-repo unborn case",
    );
  });

  it("sets detachedHead with the short SHA when child is in detached-HEAD state", () => {
    // The full 40-char SHA is truncated to 7 chars for display.
    const fullSha = "deadbee000000000000000000000000000000000";
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_DETACHED,
        okResponse({
          toplevel: CHILD_DETACHED,
          commonDir: path.join(CHILD_DETACHED, ".git"),
          abbrevRef: "HEAD",
          fullSha,
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_DETACHED, runner);

    assert.ok(result !== undefined);
    // shortSha is the first 7 chars of the 40-char fullSha.
    assert.equal(result.detachedHead, "deadbee");
    assert.equal(result.branch, undefined);
  });

  it("does not throw when the real production runner receives a hostile path", () => {
    // ITEM 3: the production runner wraps spawnSync in a try-catch so a path
    // with a NUL byte (which triggers ERR_INVALID_ARG_VALUE in Node's spawnSync)
    // never propagates into the dispatch path.
    const hostilePath = PARENT_CWD + "\x00evil";
    // Call with the real production runner (no injected seam) to exercise the
    // actual spawnSync guard. The result is indeterminate but must not throw.
    assert.doesNotThrow(() => {
      captureChildLocationSnapshot(PARENT_CWD, hostilePath);
    });
  });

  it("each call runs git independently (no module-level cache)", () => {
    // ITEM 5: verify there is no process-lifetime memoization. Two separate
    // calls with the same cwds must each invoke git (callCount === 4 total,
    // not 2).
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner, state } = makeGitRunner(responses);

    captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);
    captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    // With no cache, each call invokes git twice (once for parent, once for child).
    assert.equal(state.callCount, 4, "expected 4 git invocations (2 per call, no cache)");
  });

  it("home-shortens displayPath when child cwd is not under parent cwd", () => {
    const homeChild = path.join(os.homedir(), "some-other-project");
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        homeChild,
        okResponse({
          toplevel: homeChild,
          commonDir: path.join(homeChild, ".git"),
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, homeChild, runner);

    assert.ok(result !== undefined);
    assert.ok(
      result.displayPath.startsWith("~"),
      `Expected home-shortened path, got: ${result.displayPath}`,
    );
  });

  it("git-unavailable treated as indeterminate: no notAGitRepo, no branch, just cwd", () => {
    // Both parent and child process-error (e.g. git binary not found).
    const responses = new Map([
      [PARENT_CWD, processErrorResponse()],
      [CHILD_OTHER_REPO, processErrorResponse()],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    assert.ok(result !== undefined, "snapshot must still be returned (cwd: always shown)");
    assert.equal(
      result.notAGitRepo,
      undefined,
      "must not claim not-a-repo when git is unavailable",
    );
    assert.equal(result.branch, undefined);
    assert.equal(result.repoName, undefined);
    assert.equal(result.linkedWorktree, undefined);
    // displayPath is still set — it comes from cwd comparison, not git.
    assert.ok(result.displayPath.length > 0);
  });

  it("does NOT set notAGitRepo for a git-level failure that is not a missing-repo error (e.g. dubious ownership)", () => {
    // ITEM 3: a nonzero git exit with empty stdout but a different stderr message
    // (e.g. safe.directory refusal) must NOT produce a 'no git repo' marker.
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_NO_GIT,
        {
          stdout: "",
          processError: false,
          exitStatus: 128,
          // Dubious-ownership message — does NOT contain "not a git repository".
          stderr: "fatal: unsafe repository '/some/path' is owned by someone else",
        },
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_NO_GIT, runner);

    assert.ok(result !== undefined, "snapshot must still be returned");
    assert.equal(
      result.notAGitRepo,
      undefined,
      "must NOT set notAGitRepo for a non-repo-related git failure (e.g. dubious ownership)",
    );
    assert.ok(result.displayPath.length > 0, "displayPath must still be set");
  });

  it("makeParentGitFactsAccessor defers parent git until a child cwd differs (lazy), then caches for subsequent calls", () => {
    // The parent git runner must NOT be called until a child with a differing
    // cwd is processed. After the first triggering call it must be cached.
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "feature",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_DETACHED,
        okResponse({
          toplevel: CHILD_DETACHED,
          commonDir: path.join(CHILD_DETACHED, ".git"),
          abbrevRef: "HEAD",
          fullSha: "deadbee000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner, state } = makeGitRunner(responses);

    const accessor = makeParentGitFactsAccessor(PARENT_CWD, runner);
    // Accessor created — no git calls yet (lazy).
    assert.equal(state.callCount, 0, "accessor must not trigger git on creation");

    captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner, accessor);
    // Parent lookup triggered (first differing child) + child lookup.
    assert.equal(
      state.callCount,
      2,
      "first differing-cwd call must trigger parent lookup + child lookup",
    );

    captureChildLocationSnapshot(PARENT_CWD, CHILD_DETACHED, runner, accessor);
    // Parent is cached; only the child lookup is added.
    assert.equal(
      state.callCount,
      3,
      "subsequent differing-cwd calls must not re-invoke parent (memoized)",
    );

    // Verify that results are still correct.
    const snapshotOther = captureChildLocationSnapshot(
      PARENT_CWD,
      CHILD_OTHER_REPO,
      runner,
      accessor,
    );
    assert.ok(snapshotOther !== undefined);
    assert.equal(snapshotOther.branch, "feature");

    const snapshotDetached = captureChildLocationSnapshot(
      PARENT_CWD,
      CHILD_DETACHED,
      runner,
      accessor,
    );
    assert.ok(snapshotDetached !== undefined);
    assert.equal(snapshotDetached.detachedHead, "deadbee");
  });

  // ---------------------------------------------------------------------------
  // Zero-git property tests (headline performance claim; must not regress)
  // ---------------------------------------------------------------------------

  it("zero git invocations when all task cwds equal parent cwd (lazy accessor — common case)", () => {
    // When every parallel task shares the parent cwd the accessor must never be
    // called. This is the dispatch hot-path and must incur zero git overhead.
    const { runner, state } = makeGitRunner(new Map());
    const accessor = makeParentGitFactsAccessor(PARENT_CWD, runner);

    const r1 = captureChildLocationSnapshot(PARENT_CWD, PARENT_CWD, runner, accessor);
    const r2 = captureChildLocationSnapshot(PARENT_CWD, PARENT_CWD, runner, accessor);
    const r3 = captureChildLocationSnapshot(PARENT_CWD, PARENT_CWD, runner, accessor);

    assert.equal(r1, undefined, "cwd match must return undefined");
    assert.equal(r2, undefined);
    assert.equal(r3, undefined);
    assert.equal(
      state.callCount,
      0,
      "zero git invocations must be performed when all cwds match parent",
    );
  });

  it("parent git lookup invoked exactly once across multiple differing-cwd tasks (lazy accessor)", () => {
    // When several tasks have cwds that differ from the parent the accessor
    // must trigger the parent lookup on the first such task and cache it
    // thereafter. Total calls = 1 (parent) + N (children).
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "feature",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_DETACHED,
        okResponse({
          toplevel: CHILD_DETACHED,
          commonDir: path.join(CHILD_DETACHED, ".git"),
          abbrevRef: "HEAD",
          fullSha: "deadbee000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner, state } = makeGitRunner(responses);
    const accessor = makeParentGitFactsAccessor(PARENT_CWD, runner);

    assert.equal(state.callCount, 0, "accessor must not trigger git before first child call");

    captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner, accessor);
    // 1 parent + 1 child = 2 total
    assert.equal(state.callCount, 2, "first differing-cwd child triggers parent + child lookup");

    captureChildLocationSnapshot(PARENT_CWD, CHILD_DETACHED, runner, accessor);
    // parent is memoized; +1 child = 3 total
    assert.equal(
      state.callCount,
      3,
      "second differing-cwd child adds only 1 call (parent is memoized)",
    );

    // A third task with the same-as-parent cwd must add zero calls.
    captureChildLocationSnapshot(PARENT_CWD, PARENT_CWD, runner, accessor);
    assert.equal(
      state.callCount,
      3,
      "cwd-match task must add zero calls even when accessor is in scope",
    );
  });

  // ---------------------------------------------------------------------------
  // Indeterminate parent: relational fields must be suppressed
  // ---------------------------------------------------------------------------

  it("suppresses relational fields (repoName, branch, linkedWorktree) when parent lookup is a process error", () => {
    // A process error (binary missing, timeout) makes the parent state
    // indeterminate. Relational comparisons would produce false positives
    // (undefined !== defined is always true), so they must be suppressed.
    // Non-relational fields (displayPath, detachedHead) must still be reported.
    const responses = new Map([
      [PARENT_CWD, processErrorResponse()],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "feature",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    assert.ok(result !== undefined, "snapshot must be returned (cwd is always shown)");
    assert.equal(
      result.repoName,
      undefined,
      "repoName must not be set when parent is indeterminate",
    );
    assert.equal(result.branch, undefined, "branch must not be set when parent is indeterminate");
    assert.equal(
      result.linkedWorktree,
      undefined,
      "linkedWorktree must not be set when parent is indeterminate",
    );
    assert.ok(result.displayPath.length > 0, "displayPath must still be set");
  });

  it("suppresses relational fields when parent has a nonzero exit with non-repo-related stderr (indeterminate)", () => {
    // A nonzero git exit that does NOT contain "not a git repository" (e.g.
    // dubious-ownership refusal, config error) is indeterminate. Relational
    // fields must be suppressed; cwd must still be shown.
    const responses = new Map([
      [
        PARENT_CWD,
        {
          stdout: "",
          processError: false,
          exitStatus: 128,
          stderr: "fatal: unsafe repository '/some/path' is owned by someone else",
        },
      ],
      [
        CHILD_OTHER_REPO,
        okResponse({
          toplevel: CHILD_OTHER_REPO,
          commonDir: OTHER_COMMON_DIR,
          abbrevRef: "feature",
          fullSha: "def5678000000000000000000000000000000000",
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    assert.ok(result !== undefined, "snapshot must be returned");
    assert.equal(result.repoName, undefined, "repoName must not be set for indeterminate parent");
    assert.equal(result.branch, undefined, "branch must not be set for indeterminate parent");
    assert.equal(result.linkedWorktree, undefined);
    assert.ok(result.displayPath.length > 0, "displayPath must still be set");
  });

  it("detachedHead is still reported when parent is indeterminate (process error)", () => {
    // detachedHead is a non-relational fact about the child: it does not
    // require a parent comparison and must be reported regardless of whether
    // the parent state is known.
    const fullSha = "deadbee000000000000000000000000000000000";
    const responses = new Map([
      [PARENT_CWD, processErrorResponse()],
      [
        CHILD_DETACHED,
        okResponse({
          toplevel: CHILD_DETACHED,
          commonDir: path.join(CHILD_DETACHED, ".git"),
          abbrevRef: "HEAD",
          fullSha,
        }),
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_DETACHED, runner);

    assert.ok(result !== undefined, "snapshot must be returned");
    assert.equal(
      result.detachedHead,
      "deadbee",
      "detachedHead must be reported even when parent is indeterminate",
    );
    assert.equal(result.branch, undefined, "branch must not be set");
    assert.equal(result.repoName, undefined, "repoName must not be set (relational field)");
    assert.ok(result.displayPath.length > 0, "displayPath must be set");
  });
});

// ---------------------------------------------------------------------------
// Item 2 (ts-y7q9): process error with partial stdout must not use the
// truncated toplevel — render only the cwd, no repoName.
// ---------------------------------------------------------------------------

describe("captureChildLocationSnapshot — child process error with partial toplevel", () => {
  it("returns only the cwd when the child runner reports a process error, even if stdout contains a partial toplevel", () => {
    // A timeout or spawn failure can truncate stdout mid-line, so the
    // toplevel string in stdout may be incomplete or coincidentally match
    // a real path. parseGitRevParseOutput will parse it, but the caller
    // must discard it when processError=true.
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_OTHER_REPO,
        {
          // Partial stdout that looks like a valid toplevel, produced by a
          // truncated write before the process was killed.
          stdout: CHILD_OTHER_REPO + "\n" + OTHER_COMMON_DIR + "\n",
          processError: true, // OS-level failure (timeout/kill)
          exitStatus: null,
          stderr: "",
        },
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_OTHER_REPO, runner);

    assert.ok(result !== undefined, "snapshot must be returned (cwd is always shown)");
    // With processError=true the truncated stdout must be discarded.
    assert.equal(
      result.repoName,
      undefined,
      "repoName must NOT be set when child lookup had a process error",
    );
    assert.equal(
      result.branch,
      undefined,
      "branch must NOT be set when child lookup had a process error",
    );
    assert.equal(
      result.notAGitRepo,
      undefined,
      "notAGitRepo must NOT be set when child lookup had a process error",
    );
    assert.ok(result.displayPath.length > 0, "displayPath must still be set");
  });
});

// ---------------------------------------------------------------------------
// Item 4a (ts-y7q9): git stdout with an implausible line count (newline in a
// path) must be treated as indeterminate at the parser level.
// ---------------------------------------------------------------------------

describe("captureChildLocationSnapshot — implausible git stdout line count", () => {
  it("returns no git facts when stdout has more than 4 lines (newline in toplevel path)", () => {
    // Real git emits exactly 4 lines for a full repo (toplevel, common-dir,
    // SHA, branch).  If a directory name contains a newline the output shifts
    // to 5+ lines, mis-assigning fields (e.g. SHA as branch).  The parser
    // must detect this and return no git facts so the renderer shows only the
    // cwd without confidently wrong metadata.
    //
    // This test exercises the real parseGitRevParseOutput logic by providing
    // a runner that returns exactly what git would emit for such a path.
    const CHILD_NEWLINE_PATH = path.join(os.tmpdir(), "tlh-test-newline-child");
    const topLevelWithNewline = CHILD_NEWLINE_PATH + "\ninjected";
    const responses = new Map([
      [
        PARENT_CWD,
        okResponse({
          toplevel: PARENT_CWD,
          commonDir: PARENT_COMMON_DIR,
          abbrevRef: "main",
          fullSha: "abc1234000000000000000000000000000000000",
        }),
      ],
      [
        CHILD_NEWLINE_PATH,
        {
          // git would emit topLevelWithNewline as the first "line", which
          // causes the split to produce 5 lines (the newline inside the path
          // shifts all subsequent fields).
          stdout:
            [
              topLevelWithNewline,
              CHILD_NEWLINE_PATH + "/.git",
              "abc1234000000000000000000000000000000000",
              "main",
            ].join("\n") + "\n",
          processError: false,
          exitStatus: 0,
          stderr: "",
        },
      ],
    ]);
    const { runner } = makeGitRunner(responses);

    const result = captureChildLocationSnapshot(PARENT_CWD, CHILD_NEWLINE_PATH, runner);

    assert.ok(result !== undefined, "snapshot must be returned (cwd is always shown)");
    // When the line count is implausible all git-derived facts must be absent.
    assert.equal(
      result.repoName,
      undefined,
      "repoName must be absent when stdout has an implausible line count",
    );
    assert.equal(
      result.branch,
      undefined,
      "branch must be absent when stdout has an implausible line count",
    );
    assert.equal(
      result.detachedHead,
      undefined,
      "detachedHead must be absent when stdout has an implausible line count",
    );
    assert.ok(result.displayPath.length > 0, "displayPath must still be set");
  });
});

// ---------------------------------------------------------------------------
// Item 4b (ts-y7q9): cwd containing CR or LF must skip git entirely.
// ---------------------------------------------------------------------------

describe("captureChildLocationSnapshot — cwd contains CR or LF", () => {
  it("skips git lookup and returns only cwd when the child cwd contains a LF", () => {
    // A child cwd with an embedded newline would corrupt git's line-oriented
    // output.  The function must short-circuit before any git invocation.
    const { runner, state } = makeGitRunner(new Map());
    // Use a raw string with a LF in it.  The normalizeComparableCwd call uses
    // path.resolve which preserves the character on Unix.
    const childWithLf = path.join(os.tmpdir(), "tlh-test-parent") + "\nsubdir";

    const result = captureChildLocationSnapshot(PARENT_CWD, childWithLf, runner);

    // Because the child path contains LF, the function must return immediately
    // without calling the git runner at all.
    assert.equal(state.callCount, 0, "git must not be invoked when child cwd contains LF");
    assert.ok(result !== undefined, "snapshot must be returned");
    assert.equal(result.repoName, undefined, "repoName must be absent");
    assert.equal(result.branch, undefined, "branch must be absent");
  });

  it("skips git lookup and returns only cwd when the child cwd contains a CR", () => {
    const { runner, state } = makeGitRunner(new Map());
    const childWithCr = path.join(os.tmpdir(), "tlh-test-parent") + "\rsubdir";

    const result = captureChildLocationSnapshot(PARENT_CWD, childWithCr, runner);

    assert.equal(state.callCount, 0, "git must not be invoked when child cwd contains CR");
    assert.ok(result !== undefined, "snapshot must be returned");
    assert.equal(result.repoName, undefined, "repoName must be absent");
  });
});

// ---------------------------------------------------------------------------
// Integration test: production runner against a real detached repository
// ---------------------------------------------------------------------------

describe("captureChildLocationSnapshot (production runner, real detached HEAD)", () => {
  it("renders detachedHead as a 7-char hex SHA (not the string 'HEAD')", async (t) => {
    // Check git availability; skip cleanly if missing.
    const { spawnSync: realSpawnSync } = await import("node:child_process");
    const gitCheck = realSpawnSync("git", ["--version"], { encoding: "utf-8" });
    if (gitCheck.error || gitCheck.status !== 0) {
      // git is not installed in this environment; skip the test.
      t.skip("git not available in this environment");
      return;
    }

    const { mkdtempSync, rmSync } = await import("node:fs");
    const tmpBase = mkdtempSync(path.join(os.tmpdir(), "tlh-detached-test-"));
    // Inline identity and signing config so the test is hermetic regardless of
    // global git config (contributors with commit signing enabled must not hang).
    const gitIdentity = [
      "-c",
      "user.email=tlh-test@example.com",
      "-c",
      "user.name=TLH Test",
      "-c",
      "commit.gpgsign=false",
    ];
    try {
      // Build a self-contained fixture repo rather than cloning this
      // repository. This is faster and avoids a dependency on how CI clones
      // the repo (shallow, no commits yet, etc.).
      const fixtureDir = path.join(tmpBase, "fixture");
      const initResult = realSpawnSync("git", [...gitIdentity, "init", fixtureDir], {
        encoding: "utf-8",
      });
      if (initResult.error || initResult.status !== 0) {
        throw new Error(`git init failed (exit ${initResult.status}):\n${initResult.stderr}`);
      }

      // Create one empty commit so HEAD resolves to a real SHA.
      const commitResult = realSpawnSync(
        "git",
        [...gitIdentity, "commit", "--allow-empty", "-m", "tlh-detached-fixture-init"],
        { cwd: fixtureDir, encoding: "utf-8" },
      );
      if (commitResult.error || commitResult.status !== 0) {
        throw new Error(`git commit failed (exit ${commitResult.status}):\n${commitResult.stderr}`);
      }

      // Detach HEAD at the current commit.
      const detachResult = realSpawnSync("git", [...gitIdentity, "checkout", "--detach"], {
        cwd: fixtureDir,
        encoding: "utf-8",
      });
      if (detachResult.error || detachResult.status !== 0) {
        throw new Error(
          `git checkout --detach failed (exit ${detachResult.status}):\n${detachResult.stderr}`,
        );
      }

      // Use a parent cwd that differs from the detached repo.
      const parentCwd = os.tmpdir();
      // Run captureChildLocationSnapshot with the PRODUCTION runner.
      const snapshot = captureChildLocationSnapshot(parentCwd, fixtureDir);

      assert.ok(snapshot !== undefined, "snapshot must be returned for detached repo");
      assert.ok(
        snapshot.detachedHead !== undefined,
        `detachedHead must be set; got branch=${snapshot.branch}, detachedHead=${snapshot.detachedHead}`,
      );
      // Must be a 7-char lowercase hex string, NOT the literal 'HEAD'.
      assert.ok(
        /^[0-9a-f]{7}$/.test(snapshot.detachedHead),
        `detachedHead must be a 7-char hex SHA; got: '${snapshot.detachedHead}'`,
      );
      assert.notEqual(
        snapshot.detachedHead,
        "HEAD",
        "detachedHead must be a SHA, never the string 'HEAD'",
      );
      assert.equal(snapshot.branch, undefined, "branch must be absent in detached state");
    } finally {
      try {
        rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });
});
