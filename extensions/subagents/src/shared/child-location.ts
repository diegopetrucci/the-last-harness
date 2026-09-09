/**
 * Dispatch-time snapshot helper: captures the facts a TUI needs to explain that
 * a subagent child is working somewhere other than the parent session location.
 *
 * Rules (non-negotiable):
 * - Returns undefined immediately when child cwd equals parent cwd (common case,
 *   zero git work performed).
 * - When they differ, runs at most one git invocation per call; there is NO
 *   process-lifetime cache. rev-parse in a warm repo is single-digit milliseconds
 *   and a cache would silently hide branch changes if the parent session switches
 *   branches mid-session.
 * - Never throws: missing git binary, non-repo cwd, NUL byte in path, timeout, or
 *   non-zero exit all degrade gracefully to a no-git snapshot.
 * - Only claims "no git repo" on positive evidence (git ran successfully and the
 *   directory is outside any repository). A process-level failure (binary missing,
 *   timeout, bad cwd) is treated as indeterminate: we render only what we know.
 * - No polling, no refresh entry point. Dispatch-time only.
 */

import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeComparableCwd } from "./utils.ts";
import { shortenPath } from "./formatters.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a single `git rev-parse` invocation for one directory.
 * All fields are undefined when git is unavailable or the directory is not
 * inside a git repository.
 */
type GitInfo = {
  /** Absolute path of the repository root (--show-toplevel). */
  toplevel: string | undefined;
  /**
   * Path to the common git directory (--git-common-dir).
   * For a main worktree this is `.git`; for linked worktrees it differs from
   * toplevel but shares the same common dir as the main worktree.
   */
  commonDir: string | undefined;
  /**
   * Branch name (--abbrev-ref HEAD), or "HEAD" when in detached-HEAD state.
   */
  abbrevRef: string | undefined;
  /** Short commit SHA (--short HEAD). */
  shortSha: string | undefined;
};

/**
 * Snapshot of child-location facts captured at dispatch time.
 *
 * The footer always shows the PARENT cwd and branch; this snapshot expresses
 * only the deltas the footer cannot show.
 */
export type ChildLocationSnapshot = {
  /** Absolute path of the child working directory. */
  childCwd: string;
  /**
   * Display path: relative to the parent cwd when sensible (the child cwd is
   * underneath it), otherwise home-shortened absolute.
   */
  displayPath: string;
  /**
   * Branch name, present only when it differs from the parent branch.
   * Absent when the same branch is checked out in both locations.
   */
  branch?: string;
  /**
   * Short commit SHA, present only when the child is in detached-HEAD state
   * (abbrevRef === "HEAD").
   */
  detachedHead?: string;
  /**
   * Display-ready repository name (basename of the child's --show-toplevel),
   * present only when the child is in a DIFFERENT repository from the parent
   * (their git-common-dirs differ). The git-common-dir is used for comparison
   * but is not surfaced here; the renderer needs a short name, not an absolute
   * path.
   */
  repoName?: string;
  /**
   * True when the child cwd is a linked worktree of the SAME repository
   * (same git-common-dir, but a different toplevel).
   */
  linkedWorktree?: true;
  /**
   * True when the child cwd is outside any git repository while the parent is
   * inside one. Only set on positive evidence: git ran successfully and
   * reported that the directory is not in a repository. A process-level
   * failure (binary missing, timeout, bad cwd) is indeterminate and does NOT
   * set this flag.
   */
  notAGitRepo?: true;
};

/**
 * Validate and narrow a persisted {@link ChildLocationSnapshot} read from
 * status.json.
 *
 * Returns `undefined` when the value is absent, not a plain object, is
 * missing required string fields, or contains optional fields with unexpected
 * types.  A partially-valid snapshot is never forwarded: the whole object is
 * dropped on any shape violation so the renderer's invariant
 * (displayPath is a string) is always maintained.
 */
export function parsePersistedChildLocationSnapshot(
  value: unknown,
): ChildLocationSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  // Required string fields.
  if (typeof v["childCwd"] !== "string") return undefined;
  if (typeof v["displayPath"] !== "string") return undefined;
  // Optional string fields: present but wrong type → drop the whole snapshot.
  if (v["branch"] !== undefined && typeof v["branch"] !== "string") return undefined;
  if (v["detachedHead"] !== undefined && typeof v["detachedHead"] !== "string") return undefined;
  if (v["repoName"] !== undefined && typeof v["repoName"] !== "string") return undefined;
  // Optional boolean fields — the type only allows the literal `true`.
  if (v["linkedWorktree"] !== undefined && v["linkedWorktree"] !== true) return undefined;
  if (v["notAGitRepo"] !== undefined && v["notAGitRepo"] !== true) return undefined;

  const snapshot: ChildLocationSnapshot = {
    childCwd: v["childCwd"],
    displayPath: v["displayPath"],
  };
  if (typeof v["branch"] === "string") snapshot.branch = v["branch"];
  if (typeof v["detachedHead"] === "string") snapshot.detachedHead = v["detachedHead"];
  if (typeof v["repoName"] === "string") snapshot.repoName = v["repoName"];
  if (v["linkedWorktree"] === true) snapshot.linkedWorktree = true;
  if (v["notAGitRepo"] === true) snapshot.notAGitRepo = true;
  return snapshot;
}

/**
 * Injectable git-runner seam.
 *
 * Receives the absolute normalized cwd to inspect. Returns the raw multi-line
 * stdout from `git rev-parse --show-toplevel --git-common-dir HEAD
 * --abbrev-ref HEAD` (LC_ALL=C), a `processError` flag, the git exit status,
 * and the raw stderr.
 *
 * - `processError`: true ONLY for OS-level failures: binary missing (ENOENT),
 *   timeout, invalid cwd argument (e.g. NUL byte in path), or similar. A
 *   nonzero exit from git itself (not a repo, unborn HEAD, etc.) is NOT a
 *   process error — git ran and gave its own answer.
 * - `exitStatus`: git's numeric exit code, or `null` when `processError` is
 *   true (the process never started or was killed).
 * - `stderr`: git's stderr, always in `LC_ALL=C` locale for stable matching.
 */
export type GitRunner = (normalizedCwd: string) => {
  stdout: string;
  processError: boolean;
  exitStatus: number | null;
  stderr: string;
};

// ---------------------------------------------------------------------------
// Production git runner
// ---------------------------------------------------------------------------

/** Hard ceiling for each synchronous git call (on the parent's dispatch path). */
const GIT_TIMEOUT_MS = 500;

function parseGitRevParseOutput(stdout: string): GitInfo {
  const rawLines = stdout.split("\n");
  // Strip at most one trailing empty element produced by the newline git appends
  // after the last field. Stripping more than one would mask a newline embedded
  // in a path (which shifts all subsequent field positions).
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  // Implausible line count: normal output is 4 lines (full repo), unborn HEAD
  // is 2 (toplevel + common-dir), non-repo is 0–1 (error message or empty).
  // More than 4 lines means a newline appears inside a path, which shifts every
  // subsequent field — a SHA could be rendered as a branch name, or a truncated
  // path as a repo name. Treat as indeterminate.
  if (lines.length > 4) {
    return { toplevel: undefined, commonDir: undefined, abbrevRef: undefined, shortSha: undefined };
  }
  // Output order matches argument order:
  //   [0] --show-toplevel
  //   [1] --git-common-dir
  //   [2] HEAD          (full 40-char SHA; resolves correctly in detached state)
  //   [3] --abbrev-ref HEAD (branch name, or the literal "HEAD" when detached)
  //
  // IMPORTANT: do NOT reorder to --abbrev-ref HEAD --short HEAD. When
  // --abbrev-ref is given first it is "sticky" and --short HEAD is also
  // abbrev-ref'd, so the detached case returns "HEAD" for both lines instead of
  // the SHA for the second. The approved command is:
  //   git rev-parse --show-toplevel --git-common-dir HEAD --abbrev-ref HEAD
  const toplevel = lines[0]?.trim() || undefined;
  const rawCommonDir = lines[1]?.trim() || undefined;
  const fullSha = lines[2]?.trim() || undefined;
  const abbrevRef = lines[3]?.trim() || undefined;
  // Derive a short 7-char SHA from the full 40-char SHA for display.
  // A non-40-char value (partial output, non-repo, unborn HEAD) yields undefined.
  const shortSha = fullSha && /^[0-9a-f]{40}$/i.test(fullSha) ? fullSha.slice(0, 7) : undefined;

  // git-common-dir may be relative when inside the main worktree's .git; resolve
  // it against the toplevel so we always compare absolute paths.
  let commonDir = rawCommonDir;
  if (commonDir && toplevel && !path.isAbsolute(commonDir)) {
    commonDir = path.resolve(toplevel, commonDir);
  }
  // Normalize away any trailing slash for stable comparison.
  if (commonDir) commonDir = commonDir.replace(/[/\\]+$/, "");

  return { toplevel, commonDir, abbrevRef, shortSha };
}

/**
 * Production runner: wraps spawnSync in a try-catch so a hostile cwd (e.g. a
 * path containing a NUL byte that triggers ERR_INVALID_ARG_VALUE) degrades to
 * "no information" rather than propagating an exception into the dispatch path.
 *
 * `processError` is true only for OS-level failures; a nonzero git exit code
 * (e.g. "not a git repository") sets processError=false so the caller can
 * distinguish "git ran but found no repo" from "git could not run at all".
 */
const productionGitRunner: GitRunner = (normalizedCwd) => {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      "git",
      // Argument order is load-bearing: HEAD before --abbrev-ref HEAD ensures
      // git emits the full 40-char SHA on line 3, and the branch/detached marker
      // on line 4. Reversing them causes --abbrev-ref to be "sticky" and makes
      // both lines emit the abbreviated ref (i.e. "HEAD" in detached state).
      ["rev-parse", "--show-toplevel", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD"],
      {
        cwd: normalizedCwd,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // LC_ALL=C keeps git messages in English so stderr matching is stable
        // across locales (needed for the "not a git repository" detection).
        env: { ...process.env, LC_ALL: "C" },
      },
    );
  } catch {
    // ERR_INVALID_ARG_VALUE (NUL in path), ENOENT (no git binary), or similar.
    return { stdout: "", processError: true, exitStatus: null, stderr: "" };
  }
  // result.error is set for ENOENT (binary not found), ETIMEDOUT, etc.
  // A nonzero result.status is git's own exit code — not a process error.
  const processError = result.error !== undefined;
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    processError,
    exitStatus: processError ? null : typeof result.status === "number" ? result.status : null,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

// ---------------------------------------------------------------------------
// Git invocation helper (no cache — see module docstring)
// ---------------------------------------------------------------------------

/**
 * Run git for the given normalized cwd and return the parsed info plus whether
 * the invocation was a process-level error.
 *
 * We intentionally do NOT cache. A process-lifetime cache would silently hide
 * branch changes if the parent session switches branches mid-session between
 * consecutive dispatches.
 */
function runGitForCwd(
  normalizedCwd: string,
  runner: GitRunner,
): GitInfo & { processError: boolean; exitStatus: number | null; stderr: string } {
  const { stdout, processError, exitStatus, stderr } = runner(normalizedCwd);
  // Parse whatever stdout is available; rev-parse may emit partial output
  // (e.g. toplevel and commonDir) even when it exits nonzero (unborn repo).
  return { ...parseGitRevParseOutput(stdout), processError, exitStatus, stderr };
}

// ---------------------------------------------------------------------------
// Display path helpers
// ---------------------------------------------------------------------------

/**
 * Build a display path for the child cwd relative to the parent cwd.
 * Both arguments must be normalized (resolved, no trailing slashes or `..`
 * segments) so that `path.relative` cannot produce an odd result from raw
 * caller input.
 */
function buildDisplayPath(normalizedChild: string, normalizedParent: string): string {
  // Use relative path when the child cwd is underneath the parent.
  const rel = path.relative(normalizedParent, normalizedChild);
  // path.relative returns a string starting with ".." when the target is not
  // a descendant. A relative path with no leading ".." is always a descendant.
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel;
  }
  // Home-shorten the absolute path using the shared formatter so display is
  // consistent with every other TUI line.
  return shortenPath(normalizedChild);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-captured git facts for the parent cwd, valid for one dispatch window.
 *
 * Obtain via {@link makeParentGitFactsAccessor} — the lazy accessor is the
 * required entry point. It defers the git invocation until a child is known
 * to differ from the parent cwd, preserving the zero-git guarantee on the
 * synchronous dispatch path. Do not call the private `captureParentGitFacts`
 * function directly; it exists only to serve the accessor.
 *
 * The `_rawInfo` field is implementation-internal; callers must treat it as
 * opaque and must not construct instances of this type manually.
 */
export type ParentGitFacts = {
  readonly _rawInfo: ReturnType<typeof runGitForCwd>;
};

/**
 * Capture git facts for the parent cwd once per dispatch.
 *
 * Returns a {@link ParentGitFacts} value that can be passed to multiple
 * {@link captureChildLocationSnapshot} calls within the same dispatch, ensuring
 * git is invoked for the parent cwd exactly once regardless of how many child
 * tasks are dispatched in parallel.
 *
 * @param parentCwd - The parent session's working directory.
 * @param gitRunner - Optional injectable seam for tests.
 */
function captureParentGitFacts(
  parentCwd: string,
  gitRunner: GitRunner = productionGitRunner,
): ParentGitFacts {
  const normalizedParent = normalizeComparableCwd(parentCwd);
  return { _rawInfo: runGitForCwd(normalizedParent, gitRunner) };
}

/**
 * A memoizing accessor that computes parent git facts on first call and caches
 * the result. Obtain via {@link makeParentGitFactsAccessor}.
 *
 * Callers must treat this as an opaque callable and must not inspect its
 * closure state directly.
 */
export type ParentGitFactsAccessor = () => ParentGitFacts;

/**
 * Returns a lazy, memoizing accessor for parent git facts.
 *
 * The underlying git invocation is deferred until the accessor is first called.
 * Pass the accessor to {@link captureChildLocationSnapshot} — git for the
 * parent cwd is only invoked AFTER the child-cwd equality check, so in the
 * common case (all parallel tasks share the parent cwd) the accessor is never
 * called and zero git processes are spawned.
 *
 * A single accessor shared across all tasks in a dispatch ensures the parent
 * cwd is resolved at most once, regardless of how many tasks have a differing
 * cwd.
 *
 * @param parentCwd - The parent session's working directory.
 * @param gitRunner - Optional injectable seam for tests.
 */
export function makeParentGitFactsAccessor(
  parentCwd: string,
  gitRunner: GitRunner = productionGitRunner,
): ParentGitFactsAccessor {
  let cached: ParentGitFacts | undefined;
  return (): ParentGitFacts => {
    if (cached === undefined) {
      cached = captureParentGitFacts(parentCwd, gitRunner);
    }
    return cached;
  };
}

/**
 * Capture a dispatch-time snapshot of the facts needed to explain that a
 * subagent child is working somewhere other than the parent session.
 *
 * @param parentCwd           - The parent session's working directory (trusted source).
 * @param childCwd            - The already-resolved absolute child working directory.
 * @param gitRunner           - Optional injectable seam for tests; defaults to the
 *                              production spawnSync-based runner.
 * @param parentFactsAccessor - Optional lazy, memoizing accessor obtained from
 *                              {@link makeParentGitFactsAccessor}. When provided,
 *                              the parent git lookup is deferred until this child's
 *                              cwd is confirmed to differ from the parent, and
 *                              the cached result is reused across all tasks in
 *                              the same parallel dispatch. Pass the SAME accessor
 *                              to every call in a dispatch to guarantee at-most-one
 *                              parent invocation.
 * @returns `undefined` when the normalized cwds match (the common case, zero
 *          git work); otherwise a {@link ChildLocationSnapshot}.
 */
export function captureChildLocationSnapshot(
  parentCwd: string,
  childCwd: string,
  gitRunner: GitRunner = productionGitRunner,
  parentFactsAccessor?: ParentGitFactsAccessor,
): ChildLocationSnapshot | undefined {
  const normalizedParent = normalizeComparableCwd(parentCwd);
  const normalizedChild = normalizeComparableCwd(childCwd);

  // Common case: same cwd — return immediately without any git work.
  if (normalizedParent === normalizedChild) return undefined;

  // Compute display path from normalized paths so trailing slashes or ".."
  // segments in the raw caller arguments cannot produce an odd relative path.
  const displayPath = buildDisplayPath(normalizedChild, normalizedParent);
  const snapshot: ChildLocationSnapshot = { childCwd, displayPath };

  // If either cwd contains CR or LF, git's line-oriented output would be
  // unparseable: a newline in --show-toplevel shifts all subsequent field
  // positions, potentially misassigning a SHA as a branch name. Render only
  // the cwd and skip all git lookups.
  if (/[\r\n]/.test(normalizedChild) || /[\r\n]/.test(normalizedParent)) {
    return snapshot;
  }

  // Invoke the parent accessor now that we know the cwds differ. When an
  // accessor is provided it is memoized, so across a parallel dispatch the
  // parent git process is started at most once (and never when all children
  // share the parent cwd). Without an accessor we resolve the parent inline.
  const parentGit =
    parentFactsAccessor !== undefined
      ? parentFactsAccessor()._rawInfo
      : runGitForCwd(normalizedParent, gitRunner);
  const childGit = runGitForCwd(normalizedChild, gitRunner);

  // Child is outside a git repo — ONLY on positive evidence: git ran without a
  // process error, exited with status 128, and its stderr contains the canonical
  // "not a git repository" message (LC_ALL=C ensures the message is stable).
  // Any other nonzero exit (dubious-ownership refusal, config error, corrupt
  // repo, etc.) is indeterminate: we render only what we actually know.
  //
  // Parent gate: require no process error and a defined toplevel (the parent is
  // in a git repo). exitStatus === 0 is NOT required: an unborn parent repo
  // emits a valid toplevel with exit 128 + ambiguous-HEAD stderr.
  if (
    childGit.toplevel === undefined &&
    !childGit.processError &&
    childGit.exitStatus === 128 &&
    /not a git repository/i.test(childGit.stderr) &&
    !parentGit.processError &&
    parentGit.toplevel !== undefined
  ) {
    snapshot.notAGitRepo = true;
    return snapshot;
  }

  // Child git info is indeterminate: process error (stdout may be truncated
  // mid-line from a timeout) or no toplevel available. Return with only the
  // cwd display path.
  if (childGit.processError || childGit.toplevel === undefined) {
    return snapshot;
  }

  // Child is in a git repo (may be the same or a different one).
  //
  // Relational fields (repoName, branch, linkedWorktree) compare the child
  // against the parent and are only meaningful when the parent state is
  // POSITIVELY KNOWN:
  //   - exit 0: parent is in a repo.
  //   - exit 128 + "not a git repository" stderr: parent is positively not.
  // Any other outcome (process error, timeout, dubious-ownership refusal,
  // config error) is INDETERMINATE: suppress relational fields rather than
  // treating undefined parent values as evidence of difference.
  const parentPositivelyKnown =
    !parentGit.processError &&
    (parentGit.exitStatus === 0 ||
      (parentGit.exitStatus === 128 && /not a git repository/i.test(parentGit.stderr)));

  if (parentPositivelyKnown) {
    // Different repository: git-common-dirs differ.
    if (childGit.commonDir !== parentGit.commonDir) {
      // Surface a short, display-ready repo name derived from the toplevel
      // basename. The commonDir is used only for the comparison above; the
      // renderer must not have to parse an absolute path to recover a name.
      snapshot.repoName = path.basename(childGit.toplevel);
    } else {
      // Same repository. Check for linked worktree (same common-dir, different toplevel).
      if (childGit.toplevel !== parentGit.toplevel && parentGit.toplevel !== undefined) {
        snapshot.linkedWorktree = true;
      }
    }
  }

  // detachedHead is NON-RELATIONAL: being on a detached HEAD is a property of
  // the child alone; no parent comparison is needed. Always report it.
  if (childGit.abbrevRef === "HEAD") {
    snapshot.detachedHead = childGit.shortSha;
  } else if (
    parentPositivelyKnown &&
    childGit.abbrevRef !== undefined &&
    childGit.abbrevRef !== parentGit.abbrevRef
  ) {
    snapshot.branch = childGit.abbrevRef;
  }

  return snapshot;
}
