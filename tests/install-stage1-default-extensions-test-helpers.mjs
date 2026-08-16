import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, readPiLogRecords } from "./install-stage1-test-helpers.mjs";

import { buildInstallConfig, parseArgs } from "../scripts/tlh-install.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function scrubInstallerEnv(overrides = {}, baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === "PI_CODING_AGENT_DIR" || key.startsWith("TLH_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function writeFakeCommand(fakebin, name, body) {
  mkdirSync(fakebin, { recursive: true });
  const commandPath = join(fakebin, name);
  writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(commandPath, 0o755);
}

function writeFakePi(fakebin, body) {
  writeFakeCommand(fakebin, "pi", body);
}

export function makeDefaultExtensionInstallConfig(
  t,
  { defaultExtensions, settings, dryRun = false, fakePiBody = "exit 0", fakeGitBody = "" },
) {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const piLog = join(root, "pi.log");
  const defaultsPath = join(root, "default-extensions.json");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(defaultExtensions, null, 2));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  writeFakePi(fakebin, fakePiBody);
  if (fakeGitBody) writeFakeCommand(fakebin, "git", fakeGitBody);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: `${fakebin}:${process.env.PATH || ""}`,
    PI_LOG: piLog,
    AGENT_DIR: agentDir,
  });
  const args = ["--agent-dir", agentDir, "--bin-dir", binDir];
  if (dryRun) args.unshift("--dry-run");
  const config = buildInstallConfig(parseArgs(args, env), env);
  if (!dryRun) config.quiet = true;
  config.piCmd = join(fakebin, "pi");
  config.supportFilePaths.TLH_DEFAULTS_SCRIPT = join(repoRoot, "scripts/tlh-defaults.mjs");
  config.supportFilePaths.DEFAULT_EXTENSIONS_FILE = defaultsPath;
  return { config, agentDir, piLog };
}

export function assertPiCommands(path, agentDir, commands) {
  const records = readPiLogRecords(path);
  assert.deepEqual(
    records.map((record) => [record.agentDir, record.command]),
    commands.map((command) => [agentDir, command]),
  );
  for (const record of records) assert.equal(realpathSync(record.cwd), realpathSync(agentDir));
}
