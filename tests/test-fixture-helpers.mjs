import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function cleanupTempDir(target) {
  const dir = typeof target === "string" ? target : target?.dir;
  if (!dir) {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

export function makeTempDir(prefix, t) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t?.after?.(() => {
    cleanupTempDir(dir);
  });
  return dir;
}

export function createIsolatedProfileFixture(prefix, { cwd = false, test } = {}) {
  const dir = makeTempDir(prefix, test);
  const home = join(dir, "home");
  const agent = join(dir, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agent, { recursive: true });
  if (!cwd) {
    return { dir, home, agent };
  }
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { dir, home, agent, cwd: workspace };
}

/**
 * Create the minimal on-disk Git metadata accepted by TLH's metadata-only
 * worktree resolver. Fixtures should use this instead of invoking Git when the
 * production path under test only needs a canonical worktree boundary.
 */
export function createSyntheticGitWorktree(worktreeRoot) {
  const gitDirectory = join(worktreeRoot, ".git");
  mkdirSync(join(gitDirectory, "objects"), { recursive: true });
  mkdirSync(join(gitDirectory, "refs"), { recursive: true });
  writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(gitDirectory, "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
  return gitDirectory;
}

export async function withEnv(env, fn) {
  const previous = new Map();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
