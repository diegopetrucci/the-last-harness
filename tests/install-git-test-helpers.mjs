import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout.trim();
}

export function gitCheckoutIo(warnings) {
  return {
    runCommand(_config, commandArgs, options = {}) {
      const [command, ...args] = commandArgs;
      runCommand(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

export function listBackupRefs(targetDir) {
  const refs = runCommand("git", [
    "-C",
    targetDir,
    "for-each-ref",
    "refs/tlh-backup",
    "--format=%(refname)",
  ]);
  return refs === "" ? [] : refs.split("\n");
}
