#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  assertNotInNormalPiConfig,
  backupPathWithTimestamp,
  defaultTlhKeybindingsPath,
  expandHomePath,
  readJsonFile,
  readOptionValue,
  readRegularFileForBackup,
} from "./lib/tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./lib/tlh-safe-profile-write.mjs";

interface CliArgs {
  defaultsPath?: string;
  keybindingsPath?: string;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
}

type KeybindingMap = Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function usage(): string {
  return `Usage: node scripts/merge-keybindings.mjs [defaults.json] [options]

Merge TLH default keybindings into the isolated TLH profile without clobbering user values.

Options:
  --keybindings <path>    Keybindings file to update (default: ~/.the-last-harness/agent/keybindings.json, or PI_CODING_AGENT_DIR/keybindings.json)
  --defaults <path>       Default keybindings file (default: config/keybindings.defaults.json next to this script)
  --dry-run               Print intended changes without writing
  --quiet                 Only print errors
  -h, --help              Show this help
`;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    defaultsPath: undefined,
    keybindingsPath: undefined,
    dryRun: false,
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--quiet") {
      args.quiet = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }

    const keybindingsMatch = readOptionValue(argv, index, "--keybindings");
    if (keybindingsMatch) {
      args.keybindingsPath = keybindingsMatch.value;
      index = keybindingsMatch.nextIndex;
      continue;
    }

    const defaultsMatch = readOptionValue(argv, index, "--defaults");
    if (defaultsMatch) {
      args.defaultsPath = defaultsMatch.value;
      index = defaultsMatch.nextIndex;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (args.defaultsPath) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    args.defaultsPath = arg;
  }

  return args;
}

function defaultDefaultsPath(): string {
  return join(resolve(__dirname, ".."), "config", "keybindings.defaults.json");
}

function isPlainObject(value: unknown): value is KeybindingMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const legacyKeybindingOwners = new Map<string, readonly string[]>([
  ["app.thinking.cycle", ["cycleThinkingLevel"]],
]);

function hasExistingKeybindingOwner(keybindings: KeybindingMap, key: string): boolean {
  if (Object.hasOwn(keybindings, key)) return true;
  return (
    legacyKeybindingOwners.get(key)?.some((legacyKey) => Object.hasOwn(keybindings, legacyKey)) ??
    false
  );
}

function mergeKeybindings(
  existing: unknown,
  defaults: unknown,
): { next: KeybindingMap; changes: string[] } {
  if (!isPlainObject(existing)) {
    throw new Error("Existing keybindings must be a JSON object");
  }
  if (!isPlainObject(defaults)) {
    throw new Error("Default keybindings must be a JSON object");
  }

  const next = clone(existing);
  const changes: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (hasExistingKeybindingOwner(next, key)) continue;
    next[key] = clone(value);
    changes.push(`set ${key}`);
  }

  return { next, changes };
}

function backupPathFor(keybindingsPath: string): string {
  return backupPathWithTimestamp(keybindingsPath);
}

function assertKeybindingsTarget(keybindingsPath: string): void {
  if (basename(resolve(keybindingsPath)) !== "keybindings.json") {
    throw new Error(`Refusing to modify non-keybindings file: ${keybindingsPath}`);
  }

  assertNotInNormalPiConfig(
    keybindingsPath,
    `Refusing to modify normal Pi config from The Last Harness installer: ${keybindingsPath}`,
  );
}

function writeExistingProfileBackup(keybindingsPath: string, backupPath: string): void {
  const { content, mode } = readRegularFileForBackup(keybindingsPath, "Pi keybindings");
  writeSafeProfileFile(
    { agentDir: dirname(keybindingsPath) },
    basename(backupPath),
    content,
    "Pi keybindings backup",
    {
      mode,
    },
  );
}

function writeKeybindings(
  keybindingsPath: string,
  value: KeybindingMap,
  { dryRun, existed }: { dryRun: boolean; existed: boolean },
): string | undefined {
  const formatted = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) return undefined;

  let backupPath: string | undefined;
  if (existed) {
    backupPath = backupPathFor(keybindingsPath);
    writeExistingProfileBackup(keybindingsPath, backupPath);
  }

  writeSafeProfileFile(
    { agentDir: dirname(keybindingsPath) },
    basename(keybindingsPath),
    formatted,
    "Pi keybindings",
  );
  return backupPath;
}

function log(args: CliArgs, message: string): void {
  if (!args.quiet) console.log(message);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const defaultsPath = resolve(
    expandHomePath(args.defaultsPath || defaultDefaultsPath()) || defaultDefaultsPath(),
  );
  const keybindingsPath = resolve(
    expandHomePath(args.keybindingsPath || defaultTlhKeybindingsPath()) ||
      defaultTlhKeybindingsPath(),
  );
  assertKeybindingsTarget(keybindingsPath);
  const existed = existsSync(keybindingsPath);
  const existing = readJsonFile<KeybindingMap>(keybindingsPath, { missingValue: {} });
  const defaults = readJsonFile<KeybindingMap>(defaultsPath);
  const { next, changes } = mergeKeybindings(existing, defaults);

  log(args, `Keybindings: ${keybindingsPath}`);
  if (changes.length === 0) {
    log(args, "No keybinding changes needed.");
    return;
  }

  for (const change of changes) {
    log(args, `${args.dryRun ? "Would" : "Will"} ${change}`);
  }

  if (args.dryRun) {
    if (existed) log(args, "Would back up existing keybindings before writing.");
    log(args, "Dry run only; no keybindings were changed.");
    return;
  }

  const backupPath = writeKeybindings(keybindingsPath, next, { dryRun: args.dryRun, existed });
  if (backupPath) log(args, `Backed up previous keybindings to: ${backupPath}`);
  log(args, "Keybindings updated.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  main();
} catch (error) {
  console.error(`merge-keybindings: ${errorMessage(error)}`);
  process.exit(1);
}
