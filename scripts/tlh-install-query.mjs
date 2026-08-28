#!/usr/bin/env node
import process from "node:process";

import {
  criticalGitSourceSpec,
  formatCriticalGitSourceSpec,
  gitSourceInstallSource,
  packageSourceInstallDir,
} from "./lib/tlh-install-package-source.mjs";
import { realpathForCompare } from "./lib/tlh-install-paths.mjs";
import { defaultExtensionsRequireCriticalInstall } from "./lib/tlh-install-subagents.mjs";

// Historical stage-0 installers fetched this helper from main.
// Keep it as a thin compatibility wrapper so stale installers can still query
// current helper behavior without changing modern TLH installs.
function usage() {
  return `Usage: tlh-install-query.mjs <command> [options]

Internal installer query helper. Commands:
  critical-git-source-spec --source SOURCE --agent-dir DIR
  package-source-install-dir --source SOURCE --agent-dir DIR
  git-source-install-source --source SOURCE --agent-dir DIR
  default-extensions-require-critical-install --defaults FILE [--no-settings]
  normalize-path --path PATH
`;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      options.source = readValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length);
      if (!options.source) throw new Error("--source requires a value");
      continue;
    }
    if (arg === "--agent-dir") {
      options.agentDir = readValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--agent-dir=")) {
      options.agentDir = arg.slice("--agent-dir=".length);
      if (!options.agentDir) throw new Error("--agent-dir requires a value");
      continue;
    }
    if (arg === "--defaults") {
      options.defaults = readValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--defaults=")) {
      options.defaults = arg.slice("--defaults=".length);
      if (!options.defaults) throw new Error("--defaults requires a value");
      continue;
    }
    if (arg === "--path") {
      options.path = readValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--path=")) {
      options.path = arg.slice("--path=".length);
      if (!options.path) throw new Error("--path requires a value");
      continue;
    }
    if (arg === "--no-settings") {
      options.noSettings = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function printLine(value) {
  if (value) console.log(value);
}

function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return 0;
  }
  const options = parseOptions(argv.slice(1));
  const source = options.source ?? env.TLH_CRITICAL_SOURCE ?? env.TLH_PACKAGE_SOURCE_VALUE ?? "";
  const agentDir = options.agentDir ?? env.TLH_AGENT_DIR ?? "";

  switch (command) {
    case "critical-git-source-spec":
      printLine(formatCriticalGitSourceSpec(criticalGitSourceSpec(source, { agentDir })));
      return 0;
    case "package-source-install-dir":
      printLine(packageSourceInstallDir(source, { agentDir }));
      return 0;
    case "git-source-install-source":
      printLine(gitSourceInstallSource(source, { agentDir }));
      return 0;
    case "default-extensions-require-critical-install": {
      const defaults = options.defaults ?? env.TLH_DEFAULT_EXTENSIONS_FILE ?? "";
      return defaultExtensionsRequireCriticalInstall(defaults, {
        noSettings: Boolean(options.noSettings),
      })
        ? 0
        : 1;
    }
    case "normalize-path":
      if (options.path === undefined) throw new Error("normalize-path requires --path");
      printLine(realpathForCompare(options.path));
      return 0;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
