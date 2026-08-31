#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_MAIN_REF = "origin/main";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function readReleaseCommit() {
  const commit = process.env.GITHUB_SHA?.trim();
  if (!commit) {
    throw new Error("GITHUB_SHA is required to verify the release commit.");
  }
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new Error("GITHUB_SHA must be a 40-character commit SHA.");
  }
  return commit;
}

/**
 * Verify that a release commit is included in the repository's main branch.
 *
 * @param {string} commit
 * @param {{ cwd?: string; runGit?: typeof spawnSync }} [options]
 */
export function verifyReleaseCommitAncestry(
  commit,
  { cwd = process.cwd(), runGit = spawnSync } = {},
) {
  const result = runGit("git", ["merge-base", "--is-ancestor", commit, RELEASE_MAIN_REF], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`Unable to verify release commit ancestry: ${result.error.message}`, {
      cause: result.error,
    });
  }

  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error(`Release commit ${commit} is not reachable from ${RELEASE_MAIN_REF}.`);
  }

  const details = String(result.stderr ?? "").trim();
  throw new Error(`Unable to verify release commit ancestry${details ? `: ${details}` : "."}`);
}

function main() {
  const commit = readReleaseCommit();
  verifyReleaseCommitAncestry(commit);
  process.stdout.write(
    `Release commit ${commit} is reachable from ${RELEASE_MAIN_REF}; release may proceed.\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-release-tag-ancestry: ${message}\n`);
    process.exitCode = 1;
  }
}
