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
  /** Set only when git confirms the child is outside a repository. */
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

/** Injectable `git rev-parse` seam. `processError` is an OS-level failure, not a git exit. */
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

/** Maps a raw spawnSync result onto {@link GitRunner}. Exported for unit tests. */
export function classifySpawnSyncResult(result: {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout: string | Buffer | null | undefined;
  stderr: string | Buffer | null | undefined;
}): ReturnType<GitRunner> {
  const processError =
    result.error !== undefined || result.signal !== null || typeof result.status !== "number";
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    processError,
    exitStatus: processError ? null : typeof result.status === "number" ? result.status : null,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

const productionGitRunner: GitRunner = (normalizedCwd) => {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      "git",
      // HEAD before --abbrev-ref so line 3 stays a full SHA. See parseGitRevParseOutput.
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
  return classifySpawnSyncResult(result);
};

// ---------------------------------------------------------------------------
// Git invocation helper (no cache — see module docstring)
// ---------------------------------------------------------------------------

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

/** Parent git facts for one dispatch. Obtain via {@link makeParentGitFactsAccessor}. */
export type ParentGitFacts = {
  readonly _rawInfo: ReturnType<typeof runGitForCwd>;
};

function captureParentGitFacts(
  parentCwd: string,
  gitRunner: GitRunner = productionGitRunner,
): ParentGitFacts {
  const normalizedParent = normalizeComparableCwd(parentCwd);
  return { _rawInfo: runGitForCwd(normalizedParent, gitRunner) };
}

/** Memoizing parent-git accessor. The git call runs on first use. */
export type ParentGitFactsAccessor = () => ParentGitFacts;

/** Defers the parent git lookup until a child cwd is known to differ. */
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
 * Dispatch-time child-location snapshot.
 * Returns undefined when the normalized cwds match.
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

  // Parent lookup is shared when an accessor is provided; otherwise resolve inline.
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
