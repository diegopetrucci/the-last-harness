#!/usr/bin/env node
import { relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  assertNotInNormalPiConfig,
  assignOptionValue,
  readOptionValue,
} from "./lib/tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./lib/tlh-safe-profile-write.mjs";

function usage() {
  return `Usage: tlh-install-state.mjs [options]

Write The Last Harness installer update metadata.

Options:
  --state-path PATH                 install-state.json path
  --repo OWNER/REPO                 GitHub repository
  --ref REF                         Installed ref/tag/commit
  --track TRACK                     Update track
  --package-source SOURCE           Pi package source
  --package-source-is-default BOOL  Whether package source was installer-derived
  --raw-base URL                    Raw support-file base URL
  --agent-dir DIR                   Isolated Pi agent dir
  --bin-dir DIR                     Wrapper install dir
  --wrapper-name NAME               Wrapper command name
  --commit-subject SUBJECT          Installed TLH checkout HEAD subject (optional)
  --pi-installed-by-tlh BOOL        Whether TLH installed Pi globally (true|false; omit to leave field absent)
  --dry-run                         Print intended changes without writing
  --quiet                           Suppress non-essential output
  -h, --help                        Show this help
`;
}

function parseArgs(argv) {
  const args = {
    statePath: undefined,
    repo: undefined,
    ref: undefined,
    track: undefined,
    packageSource: undefined,
    packageSourceIsDefault: undefined,
    rawBase: undefined,
    agentDir: undefined,
    binDir: undefined,
    wrapperName: undefined,
    commitSubject: undefined,
    piInstalledByTlh: undefined,
    dryRun: false,
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--quiet") {
      args.quiet = true;
      continue;
    }
    const statePathIndex = assignOptionValue(args, "statePath", argv, index, "--state-path");
    if (statePathIndex !== undefined) {
      index = statePathIndex;
      continue;
    }
    const repoIndex = assignOptionValue(args, "repo", argv, index, "--repo");
    if (repoIndex !== undefined) {
      index = repoIndex;
      continue;
    }
    const refIndex = assignOptionValue(args, "ref", argv, index, "--ref");
    if (refIndex !== undefined) {
      index = refIndex;
      continue;
    }
    const trackIndex = assignOptionValue(args, "track", argv, index, "--track");
    if (trackIndex !== undefined) {
      index = trackIndex;
      continue;
    }
    const packageSourceIndex = assignOptionValue(
      args,
      "packageSource",
      argv,
      index,
      "--package-source",
    );
    if (packageSourceIndex !== undefined) {
      index = packageSourceIndex;
      continue;
    }
    const packageSourceIsDefaultIndex = assignOptionValue(
      args,
      "packageSourceIsDefault",
      argv,
      index,
      "--package-source-is-default",
    );
    if (packageSourceIsDefaultIndex !== undefined) {
      index = packageSourceIsDefaultIndex;
      continue;
    }
    const rawBaseIndex = assignOptionValue(args, "rawBase", argv, index, "--raw-base");
    if (rawBaseIndex !== undefined) {
      index = rawBaseIndex;
      continue;
    }
    const agentDirIndex = assignOptionValue(args, "agentDir", argv, index, "--agent-dir");
    if (agentDirIndex !== undefined) {
      index = agentDirIndex;
      continue;
    }
    const binDirIndex = assignOptionValue(args, "binDir", argv, index, "--bin-dir");
    if (binDirIndex !== undefined) {
      index = binDirIndex;
      continue;
    }
    const wrapperNameIndex = assignOptionValue(args, "wrapperName", argv, index, "--wrapper-name");
    if (wrapperNameIndex !== undefined) {
      index = wrapperNameIndex;
      continue;
    }
    const commitSubjectIndex = assignOptionValue(
      args,
      "commitSubject",
      argv,
      index,
      "--commit-subject",
    );
    if (commitSubjectIndex !== undefined) {
      index = commitSubjectIndex;
      continue;
    }
    const piInstalledByTlh = readOptionValue(argv, index, "--pi-installed-by-tlh");
    if (piInstalledByTlh) {
      const raw = piInstalledByTlh.value;
      const lower = raw.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new Error(`--pi-installed-by-tlh must be true or false (got: ${raw})`);
      }
      args.piInstalledByTlh = lower === "true";
      index = piInstalledByTlh.nextIndex;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return args;
}

function validateArgs(args) {
  for (const [key, flag] of [
    ["statePath", "--state-path"],
    ["repo", "--repo"],
    ["ref", "--ref"],
    ["track", "--track"],
    ["packageSource", "--package-source"],
    ["packageSourceIsDefault", "--package-source-is-default"],
    ["rawBase", "--raw-base"],
    ["agentDir", "--agent-dir"],
    ["binDir", "--bin-dir"],
    ["wrapperName", "--wrapper-name"],
  ]) {
    if (!args[key]) throw new Error(`${flag} is required`);
  }
}

function parseBoolean(value, flag) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${flag} must be true or false`);
}

function assertNotNormalPiPath(path, label) {
  assertNotInNormalPiConfig(
    path,
    `refusing to modify normal Pi config from The Last Harness install-state command (${label}): ${path}`,
  );
}

function log(args, message) {
  if (!args.quiet) console.log(message);
}

function buildState(args) {
  const state = {
    schemaVersion: 1,
    repo: args.repo,
    ref: args.ref,
    track: args.track,
    packageSource: args.packageSource,
    packageSourceIsDefault: parseBoolean(
      args.packageSourceIsDefault,
      "--package-source-is-default",
    ),
    rawBase: args.rawBase,
    agentDir: args.agentDir,
    binDir: args.binDir,
    wrapperName: args.wrapperName,
    installedAt: new Date().toISOString(),
  };
  const commitSubject = args.commitSubject?.trim();
  if (commitSubject) {
    state.commitSubject = commitSubject;
  }
  if (args.piInstalledByTlh !== undefined) {
    state.piInstalledByTlh = args.piInstalledByTlh;
  }
  return state;
}

function stateRelativePath(args) {
  return relative(resolve(args.agentDir), resolve(args.statePath)).split(sep).join("/");
}

function writeInstallState(args) {
  if (args.dryRun) {
    const piField =
      args.piInstalledByTlh !== undefined ? ` (piInstalledByTlh: ${args.piInstalledByTlh})` : "";
    log(args, `Would write tlh update metadata: ${args.statePath}${piField}`);
    return;
  }

  const state = buildState(args);
  writeSafeProfileFile(
    { agentDir: args.agentDir },
    stateRelativePath(args),
    `${JSON.stringify(state, null, 2)}\n`,
    "TLH install state",
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  validateArgs(args);
  assertNotNormalPiPath(args.statePath, "state path");
  assertNotNormalPiPath(args.agentDir, "agent dir");
  assertNotNormalPiPath(args.binDir, "wrapper install dir");
  writeInstallState(args);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
