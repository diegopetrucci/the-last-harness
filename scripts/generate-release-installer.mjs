#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const SAFE_REF_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const SAFE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const INTEGRITY_HEREDOC =
  "  cat <<'EOF_RELEASE_INTEGRITY_MANIFEST'\nEOF_RELEASE_INTEGRITY_MANIFEST";

function usage() {
  return `Usage: node scripts/generate-release-installer.mjs --tag TAG [options]

Generate a release install.sh with tag-bound support-file SHA-256 checksums.

Options:
  --tag TAG       Release tag, for example v1.2.3 (required)
  --output PATH   Generated installer path (default: dist/install.sh)
  --root DIR      Tagged checkout root (default: repository root)
  --repo REPO     Release repository owner/name (default: ${DEFAULT_REPO})
  -h, --help      Show this help
`;
}

function fail(message) {
  throw new Error(message);
}

function replaceOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(`Expected exactly one ${label} in install.sh; found ${count}.`);
  }
  return source.replace(oldText, newText);
}

function assertSafeRelativePath(relativePath, label = "path") {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    !SAFE_RELATIVE_PATH_PATTERN.test(relativePath) ||
    relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail(`Unsafe release support ${label}: ${relativePath}`);
  }
}

function extractHeredocLines(source, label) {
  const opener = `cat <<'${label}'`;
  const openerIndex = source.indexOf(opener);
  if (openerIndex === -1) fail(`install.sh is missing the ${label} manifest heredoc.`);

  const bodyStart = source.indexOf("\n", openerIndex);
  if (bodyStart === -1) fail(`install.sh has an unterminated ${label} manifest heredoc.`);
  const endMarker = `\n${label}`;
  const bodyEnd = source.indexOf(endMarker, bodyStart + 1);
  if (bodyEnd === -1) fail(`install.sh has an unterminated ${label} manifest heredoc.`);

  return source
    .slice(bodyStart + 1, bodyEnd)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function parseSupportRows(lines, label) {
  return lines.map((line, index) => {
    const parts = line.split("|");
    if (parts.length !== 2 || !["required", "optional"].includes(parts[0])) {
      fail(`Invalid ${label} manifest entry ${index + 1}: ${line}`);
    }
    const [requirement, relativePath] = parts;
    assertSafeRelativePath(relativePath, `${label} manifest path`);
    return { requirement, relativePath };
  });
}

function readTargetSource(rootDir, candidates, label) {
  for (const relativePath of candidates) {
    const sourcePath = join(rootDir, relativePath);
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile()) {
        fail(`Target ${label} must be a regular checkout file: ${relativePath}`);
      }
      return readFileSync(sourcePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        fail(`Unable to read target ${label} ${relativePath}: ${error.message}`);
      }
    }
  }
  fail(`Target checkout is missing ${label} (${candidates.join(" or ")}).`);
}

function extractTargetSupportRows(source) {
  const requiredConstant = source.match(/const REQUIRED(?:\s*:[^=]+)?\s*=\s*["']([^"']+)["']/)?.[1];
  const optionalConstant = source.match(/const OPTIONAL(?:\s*:[^=]+)?\s*=\s*["']([^"']+)["']/)?.[1];
  if (requiredConstant === undefined || optionalConstant === undefined) {
    fail("Target support manifest is missing REQUIRED/OPTIONAL constants.");
  }

  const rows = [];
  const descriptorPattern =
    /requirement:\s*(REQUIRED|OPTIONAL)\s*,\s*relativePath:\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(descriptorPattern)) {
    rows.push({
      requirement: match[1] === "REQUIRED" ? requiredConstant : optionalConstant,
      relativePath: match[2],
    });
  }
  if (rows.length === 0) fail("Target support manifest contains no support-file descriptors.");
  return rows;
}

function extractTargetPromptList(source) {
  const match = source.match(/TLH_SUBAGENT_PROMPTS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (match === null) fail("Target subagent support module is missing TLH_SUBAGENT_PROMPTS.");
  const prompts = [...match[1].matchAll(/["']([A-Za-z0-9._-]+\.md)["']/g)].map(
    (prompt) => prompt[1],
  );
  if (prompts.length === 0) fail("Target subagent support module contains no prompts.");
  return prompts;
}

function extractPromptList(source) {
  const declaration = "TLH_SUBAGENT_PROMPTS=(";
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex === -1) fail("install.sh is missing TLH_SUBAGENT_PROMPTS.");
  const bodyStart = declarationIndex + declaration.length;
  const bodyEnd = source.indexOf(")", bodyStart);
  if (bodyEnd === -1) fail("install.sh has an unterminated TLH_SUBAGENT_PROMPTS declaration.");

  const prompts = [...source.slice(bodyStart, bodyEnd).matchAll(/([A-Za-z0-9._-]+\.md)/g)].map(
    (match) => match[1],
  );
  if (prompts.length === 0) fail("install.sh has no bundled subagent prompts.");
  return prompts;
}

function assertSameRows(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some(
      (row, index) =>
        row.requirement !== expected[index].requirement ||
        row.relativePath !== expected[index].relativePath,
    )
  ) {
    fail(`${label} is incomplete or out of sync with the stage-1 support manifest.`);
  }
}

function assertUniquePaths(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    assertSafeRelativePath(entry.relativePath, `${label} path`);
    if (seen.has(entry.relativePath)) {
      fail(`Duplicate ${label} path: ${entry.relativePath}`);
    }
    seen.add(entry.relativePath);
  }
}

/**
 * Validate the complete set of files that a matching release asset can fetch.
 * The validation deliberately uses lstat so a symlink cannot become a release
 * checksum source in place of a regular checkout file.
 *
 * @param {{ rootDir: string; installSource: string }} options
 * @returns {Array<{ requirement: string; relativePath: string }>}
 */
export function collectReleaseSupportInventory({ rootDir, installSource }) {
  const stage0Rows = [
    ...parseSupportRows(extractHeredocLines(installSource, "EOF_SUPPORT_FILES"), "stage-0"),
    ...parseSupportRows(
      extractHeredocLines(installSource, "EOF_SETTINGS_SUPPORT_FILES"),
      "stage-0 settings",
    ),
  ];
  const targetManifestSource = readTargetSource(
    rootDir,
    [
      "scripts/lib/tlh-install-support-manifest.mts",
      "scripts/lib/tlh-install-support-manifest.mjs",
    ],
    "support manifest",
  );
  const stage1Rows = extractTargetSupportRows(targetManifestSource);
  assertUniquePaths(stage0Rows, "stage-0 support manifest");
  assertSameRows(stage0Rows, stage1Rows, "Stage-0 support manifest");

  const sourcePrompts = extractPromptList(installSource);
  const targetPromptSource = readTargetSource(
    rootDir,
    ["scripts/lib/tlh-install-subagents.mts", "scripts/lib/tlh-install-subagents.mjs"],
    "subagent support module",
  );
  const targetPrompts = extractTargetPromptList(targetPromptSource);
  if (JSON.stringify(sourcePrompts) !== JSON.stringify(targetPrompts)) {
    fail("Stage-0 bundled subagent prompt list is incomplete or out of sync with stage 1.");
  }
  const promptRows = sourcePrompts.map((prompt) => ({
    requirement: "subagent",
    relativePath: `agents/subagents/${prompt}`,
  }));
  assertUniquePaths(promptRows, "bundled subagent prompt");

  const inventory = [...stage0Rows, ...promptRows];
  assertUniquePaths(inventory, "release support inventory");

  for (const { relativePath } of inventory) {
    const sourcePath = join(rootDir, relativePath);
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch (error) {
      fail(`Unable to read release support file ${relativePath}: ${error.message}`);
    }
    if (!stat.isFile()) {
      fail(`Release support file must be a regular checkout file: ${relativePath}`);
    }
  }

  return inventory;
}

/**
 * Generate a release installer from a tagged checkout.
 *
 * @param {{ rootDir?: string; outputPath: string; tag: string; repo?: string }} options
 * @returns {{ outputPath: string; tag: string; repo: string; inventory: Array<{ requirement: string; relativePath: string; sha256: string }> }}
 */
export function generateReleaseInstaller({
  rootDir = DEFAULT_ROOT,
  outputPath,
  tag,
  repo = DEFAULT_REPO,
}) {
  if (typeof tag !== "string" || !SAFE_REF_PATTERN.test(tag)) {
    fail(`Release tag must be a semver tag such as v1.2.3: ${tag}`);
  }
  if (typeof repo !== "string" || !SAFE_REPO_PATTERN.test(repo)) {
    fail(`Release repository must be owner/name: ${repo}`);
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("An output path is required.");
  }

  rootDir = resolve(rootDir);
  outputPath = resolve(outputPath);
  const sourcePath = join(rootDir, "install.sh");
  let installSource;
  try {
    const sourceStat = lstatSync(sourcePath);
    if (!sourceStat.isFile())
      fail("Release installer source must be a regular checkout file: install.sh");
    installSource = readFileSync(sourcePath, "utf8");
  } catch (error) {
    fail(`Unable to read ${sourcePath}: ${error.message}`);
  }

  const inventory = collectReleaseSupportInventory({ rootDir, installSource });
  const checksummedInventory = inventory.map(({ requirement, relativePath }) => ({
    requirement,
    relativePath,
    sha256: createHash("sha256")
      .update(readFileSync(join(rootDir, relativePath)))
      .digest("hex"),
  }));
  if (
    checksummedInventory.length !== inventory.length ||
    new Set(checksummedInventory.map(({ relativePath }) => relativePath)).size !== inventory.length
  ) {
    fail("Generated release checksum inventory is incomplete or duplicated.");
  }

  let output = installSource;
  output = replaceOnce(
    output,
    'REPO="${TLH_REPO:-diegopetrucci/the-last-harness}"',
    `REPO="\${TLH_REPO:-${repo}}"`,
    "the repository default",
  );
  output = replaceOnce(
    output,
    'REF="${TLH_REF:-main}"',
    `REF="\${TLH_REF:-${tag}}"`,
    "the source ref default",
  );
  output = replaceOnce(
    output,
    'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"',
    'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-latest-release}"',
    "the update-track default",
  );
  output = replaceOnce(
    output,
    'TLH_RELEASE_INTEGRITY_REPO=""',
    `TLH_RELEASE_INTEGRITY_REPO="${repo}"`,
    "the release repository marker",
  );
  output = replaceOnce(
    output,
    'TLH_RELEASE_INTEGRITY_REF=""',
    `TLH_RELEASE_INTEGRITY_REF="${tag}"`,
    "the release ref marker",
  );
  const manifestBody = checksummedInventory
    .map(({ relativePath, sha256 }) => `${relativePath}|${sha256}`)
    .join("\n");
  output = replaceOnce(
    output,
    INTEGRITY_HEREDOC,
    `  cat <<'EOF_RELEASE_INTEGRITY_MANIFEST'\n${manifestBody}\nEOF_RELEASE_INTEGRITY_MANIFEST`,
    "the release integrity manifest placeholder",
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o755 });
  return { outputPath, tag, repo, inventory: checksummedInventory };
}

function parseOptions(argv) {
  const options = { outputPath: resolve(process.cwd(), "dist/install.sh"), rootDir: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(usage());
      return null;
    }
    if (!["--tag", "--output", "--root", "--repo"].includes(argument)) {
      if (argument.startsWith("--tag=")) {
        options.tag = argument.slice("--tag=".length);
      } else if (argument.startsWith("--output=")) {
        options.outputPath = argument.slice("--output=".length);
      } else if (argument.startsWith("--root=")) {
        options.rootDir = argument.slice("--root=".length);
      } else if (argument.startsWith("--repo=")) {
        options.repo = argument.slice("--repo=".length);
      } else {
        fail(`Unknown option: ${argument}`);
      }
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("-")) {
      fail(`${argument} requires a value.`);
    }
    const value = argv[++index];
    if (argument === "--tag") options.tag = value;
    if (argument === "--output") options.outputPath = value;
    if (argument === "--root") options.rootDir = value;
    if (argument === "--repo") options.repo = value;
  }
  if (options.tag === undefined) fail("--tag is required.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options !== null) {
      const result = generateReleaseInstaller(options);
      process.stdout.write(
        `Generated ${result.outputPath} with ${result.inventory.length} release support-file SHA-256 entries bound to ${result.tag}.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
