#!/usr/bin/env node
/**
 * tlh-version — read-only version/provenance reporter.
 *
 * Backs `tlh version [--json]`. No network, no subprocesses, no writes.
 * Intentionally imports only node: builtins so it works when other support
 * files are broken.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 1;
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_PARENT_WALK = 16;

interface CliArgs {
  agentDir?: string;
  packageRoot?: string;
  piCmd: string;
  json: boolean;
  help: boolean;
}

interface VersionInfo {
  schemaVersion: number;
  tlhVersion: string | null;
  piVersion: string | null;
  track: string | null;
  ref: string | null;
  repo: string | null;
  agentDir: string;
}

const USAGE = `Usage: tlh version [--json]

Internal usage:
  tlh-version.mjs --agent-dir DIR --package-root DIR [--pi-cmd PATH] [--json]

Options:
  --agent-dir DIR      Isolated tlh profile directory (required)
  --package-root DIR   Installed tlh package root (required)
  --pi-cmd PATH        Path to the upstream pi executable (optional)
  --json               Print machine-readable JSON
  -h, --help           Show this help
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { piCmd: "", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (name: string): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
      i++;
      return value;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--agent-dir") args.agentDir = takeValue(arg);
    else if (arg === "--package-root") args.packageRoot = takeValue(arg);
    else if (arg === "--pi-cmd") args.piCmd = takeValue(arg);
    else if (arg.startsWith("--agent-dir=")) args.agentDir = arg.slice("--agent-dir=".length);
    else if (arg.startsWith("--package-root="))
      args.packageRoot = arg.slice("--package-root=".length);
    else if (arg.startsWith("--pi-cmd=")) args.piCmd = arg.slice("--pi-cmd=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help) {
    if (args.agentDir === undefined || args.agentDir === "") {
      throw new Error("--agent-dir is required");
    }
    if (args.packageRoot === undefined || args.packageRoot === "") {
      throw new Error("--package-root is required");
    }
  }
  return args;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
  } catch {
    // Missing/unreadable/invalid: report as unknown.
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readPiVersion(piCmd: string): string | null {
  if (piCmd === "") return null;
  let dir: string;
  try {
    dir = dirname(realpathSync(piCmd));
  } catch {
    return null;
  }
  for (let i = 0; i < MAX_PARENT_WALK; i++) {
    const pkg = readJsonObject(join(dir, "package.json"));
    if (pkg !== null && pkg.name === PI_PACKAGE_NAME) return nonEmptyString(pkg.version);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function collect(args: { agentDir: string; packageRoot: string; piCmd: string }): VersionInfo {
  const pkg = readJsonObject(join(args.packageRoot, "package.json"));
  const state = readJsonObject(join(args.agentDir, "tlh", "install-state.json"));
  return {
    schemaVersion: SCHEMA_VERSION,
    tlhVersion: pkg === null ? null : nonEmptyString(pkg.version),
    piVersion: readPiVersion(args.piCmd),
    track: state === null ? null : nonEmptyString(state.track),
    ref: state === null ? null : nonEmptyString(state.ref),
    repo: state === null ? null : nonEmptyString(state.repo),
    agentDir: args.agentDir,
  };
}

function formatText(info: VersionInfo): string {
  const unknown = (value: string | null): string => value ?? "unknown";
  const track =
    info.track === null
      ? "unknown"
      : info.ref === null
        ? info.track
        : `${info.track} (${info.ref})`;
  return [
    `TLH version: ${unknown(info.tlhVersion)}`,
    `Pi runtime version: ${unknown(info.piVersion)}`,
    `Track: ${track}`,
    `Repository: ${unknown(info.repo)}`,
    `Profile dir: ${info.agentDir}`,
    "",
  ].join("\n");
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `tlh version: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const info = collect({
    agentDir: args.agentDir ?? "",
    packageRoot: args.packageRoot ?? "",
    piCmd: args.piCmd,
  });
  process.stdout.write(args.json ? `${JSON.stringify(info, null, 2)}\n` : formatText(info));
}

main();
