import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
