// Discover .claude/skills directories and surface them to the Pi runtime via
// the resources_discover hook. Existence-filters results before returning so
// the runtime never emits "skill path does not exist" diagnostics for paths
// added by this extension.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { TlhSettings } from "./types.js";

/**
 * Return the resolved path to the user-root Claude skills directory.
 * Evaluated lazily (at call time) so changes to HOME in the process environment
 * are respected, which is important for tests that set a fixture HOME.
 */
function getUserClaudeSkills(): string {
  return join(homedir(), ".claude", "skills");
}

/**
 * Walk from `startDir` up to the git repository root, collecting
 * `<dir>/.claude/skills` at each level. Stops at the git root (the first
 * directory that contains a `.git` entry) or at the filesystem root.
 *
 * Mirrors the upstream `collectAncestorAgentsSkillDirs` walk in
 * dist/core/package-manager.js, substituting `.claude/skills` for
 * `.agents/skills`.
 */
function collectAncestorClaudeSkillDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(startDir);
  const gitRoot = findGitRoot(dir);

  while (true) {
    dirs.push(join(dir, ".claude", "skills"));

    if (gitRoot !== null && dir === gitRoot) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root.
      break;
    }
    dir = parent;
  }

  return dirs;
}

/**
 * Walk upward from `startDir` and return the first directory that contains a
 * `.git` file or directory, or `null` if none is found.
 */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function isClaudeSkillsDisabled(cwd: string): boolean {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
    return settings.tlh?.claudeSkills?.disabled === true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path to its real path when it exists, otherwise return `null`.
 * Used for deduplication by resolved identity rather than string equality.
 */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Append `candidate` to `skillPaths` if it exists on disk and has not already
 * been seen (by resolved real path). Mutates both `seen` and `skillPaths`.
 */
function appendIfNew(candidate: string, seen: Set<string>, skillPaths: string[]): void {
  // Use statSync (which follows symlinks) so that a symlinked directory is
  // accepted but a regular file at the candidate path is rejected. existsSync
  // would return true for a file, causing the runtime to emit a
  // "skill path is not a markdown file" diagnostic.
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(candidate);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const real = tryRealpath(candidate);
  if (real === null || seen.has(real)) {
    return;
  }
  seen.add(real);
  skillPaths.push(candidate);
}

export function registerClaudeSkillsDiscovery(pi: ExtensionAPI): void {
  pi.on("resources_discover", async (event, ctx) => {
    if (isClaudeSkillsDisabled(event.cwd)) {
      return undefined;
    }

    const seen = new Set<string>();
    const skillPaths: string[] = [];

    // User root is always a candidate and is added first so it wins
    // any same-name skill collision against project roots (upstream keeps
    // the first registration per skill name).
    const userClaudeSkills = getUserClaudeSkills();
    appendIfNew(userClaudeSkills, seen, skillPaths);

    // Project roots are included only when the project is trusted.
    // Use optional-call defensive convention (matching getActiveProjectTrustDecision in
    // extensions/the-last-harness.ts): treat anything other than boolean true as untrusted.
    // Any project root that resolves to the same real path as the user root
    // is silently dropped by the seen-set deduplication above.
    if (ctx.isProjectTrusted?.() === true) {
      for (const candidate of collectAncestorClaudeSkillDirs(event.cwd)) {
        appendIfNew(candidate, seen, skillPaths);
      }
    }

    if (skillPaths.length === 0) {
      return undefined;
    }

    return { skillPaths };
  });
}
