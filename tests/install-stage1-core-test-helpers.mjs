import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoNodeModulesBin = join(repoRoot, "node_modules", ".bin");
export const TLH_NON_PINNED_PI_VERSION = "0.80.1";
export const TLH_PINNED_PI_VERSION = "1.5.2";

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pathWithoutRepoNodeModulesBin(pathValue = process.env.PATH || "") {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== repoNodeModulesBin)
    .join(delimiter);
}

/**
 * Throws when `env` would let an installer/uninstaller reach the developer's real
 * Herdr.app home (HERDR_APP_HOME, or <HOME>/.config/herdr-app when unset) under the
 * real user home directory.
 */
export function assertHerdrAppHomeIsolated(env) {
  const realHome = resolve(userInfo().homedir);
  const home = env.HOME || realHome;
  let configured = (env.HERDR_APP_HOME || "").trim();
  if (configured === "~" || configured.startsWith("~/"))
    configured = join(home, configured.slice(1));
  const appHome = resolve(configured || join(home, ".config", "herdr-app"));
  const rel = relative(realHome, appHome);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`test env would touch the real Herdr.app home: ${appHome}`);
  }
}

/**
 * Builds an installer env without inherited PI/TLH/HERDR overrides. HERDR_APP_HOME
 * is always pinned to a temp-side path (under the overridden HOME when given) and
 * the result is asserted not to resolve under the real user home. Pass
 * `HERDR_APP_HOME` in `overrides` to choose a specific temp app home.
 */
export function scrubInstallerEnv(overrides = {}, baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === "PI_CODING_AGENT_DIR" || key === "HERDR_APP_HOME" || key.startsWith("TLH_")) {
      continue;
    }
    env[key] = value;
  }
  const merged = { ...env, ...overrides };
  if (!Object.hasOwn(overrides, "HERDR_APP_HOME")) {
    merged.HERDR_APP_HOME = overrides.HOME
      ? join(overrides.HOME, ".config", "herdr-app")
      : join(tmpdir(), "tlh-test-herdr-app-home");
  } else if (overrides.HERDR_APP_HOME === undefined) {
    // Explicit opt-in to "unset": the default then derives from the (temp) HOME.
    delete merged.HERDR_APP_HOME;
  }
  assertHerdrAppHomeIsolated(merged);
  return merged;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function safeInstallerPath(fakebin) {
  return [fakebin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

// ---------------------------------------------------------------------------
// Installer runner helpers
// ---------------------------------------------------------------------------

export function runInstaller(args, env = scrubInstallerEnv()) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-install.mjs"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runHelper(scriptRelativePath, args, { homeDir }) {
  const scriptPath = join(repoRoot, scriptRelativePath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: scrubInstallerEnv({ HOME: homeDir }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `${scriptRelativePath} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

// ---------------------------------------------------------------------------
// Fake command writers
// ---------------------------------------------------------------------------

export function writeFakeCommand(fakebin, name, body) {
  mkdirSync(fakebin, { recursive: true });
  const commandPath = join(fakebin, name);
  writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(commandPath, 0o755);
}

export function writeFakePi(fakebin, body) {
  writeFakeCommand(fakebin, "pi", body);
}

export function writeFakeTk(fakebin) {
  writeFakeCommand(fakebin, "tk", "printf 'Usage: tk help\\nTicket CLI helper\\n'");
}

/**
 * Write a fake npm that handles `npm ci --ignore-scripts --no-audit --no-fund`
 * called with cwd = the staging dir (the new lockfile-based install path).
 * The fake npm creates the staged node_modules structure relative to its cwd.
 */
export function writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath }) {
  writeFakeCommand(
    fakebin,
    "npm",
    [
      `printf '%s\\n' "$*" >>"${npmLog}"`,
      `if [[ "$1" == "ci" ]]; then`,
      `  mkdir -p "node_modules/@earendil-works/pi-coding-agent/dist/bundle"`,
      `  cp "${templatePiPath}" "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"`,
      `  chmod +x "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"`,
      `fi`,
    ].join("\n"),
  );
}

export function writeLoggingPi(commandDir, logPath, version = TLH_PINNED_PI_VERSION) {
  writeFakePi(
    commandDir,
    [
      `printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${logPath}"`,
      `if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
      "exit 0",
    ].join("\n"),
  );
}

export function writeVersionedWrapperPi(commandDir, logPath, version = TLH_PINNED_PI_VERSION) {
  writeFakePi(
    commandDir,
    [
      `if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
      `{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${logPath}"`,
      "exit 0",
    ].join("\n"),
  );
}

/**
 * Seed a runtime's lib/package-lock.json with the shipped lock so that the
 * reuse-check (byte-identical comparison) passes for the given runtimeDir.
 * With `linkPi`, also link bin/pi to the lib CLI (see linkRuntimePiToLibCli).
 */
export function seedRuntimeLock(runtimeDir, { linkPi = false } = {}) {
  const shippedLock = join(repoRoot, "config", "pi-runtime", "package-lock.json");
  if (existsSync(shippedLock)) {
    mkdirSync(join(runtimeDir, "lib"), { recursive: true });
    copyFileSync(shippedLock, join(runtimeDir, "lib", "package-lock.json"));
  }
  if (linkPi) linkRuntimePiToLibCli(runtimeDir);
}

/**
 * Make an existing regular-file <runtimeDir>/bin/pi resolve like a real TLH
 * runtime: move it to the lib CLI path and replace it with the managed relative
 * symlink, so the reuse identity check (bin/pi -> current lib CLI) passes.
 */
export function linkRuntimePiToLibCli(runtimeDir) {
  const cli = join(
    runtimeDir,
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  mkdirSync(dirname(cli), { recursive: true });
  renameSync(join(runtimeDir, "bin", "pi"), cli);
  symlinkSync(
    "../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    join(runtimeDir, "bin", "pi"),
  );
}

export function writeWrapperHelperLogger(scriptPath, logEnvVar, source) {
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.${logEnvVar}, JSON.stringify({ source: ${JSON.stringify(source)}, argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// High-level test orchestration helpers
// ---------------------------------------------------------------------------

export function runStage1LocalPackageInstall(
  t,
  {
    dryRun = false,
    noSettings = false,
    force = false,
    verbose = false,
    existingSupportFiles,
    existingAgentFiles,
    existingManagedRtk = false,
    envOverrides = {},
  } = {},
) {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const piLog = join(root, "pi.log");
  const templateDir = join(root, "pi-template");
  const npmLog = join(root, "npm.log");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  if (existingAgentFiles) {
    for (const [relativePath, content] of Object.entries(existingAgentFiles)) {
      const target = join(agentDir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  writeFakeTk(fakebin);
  writeLoggingPi(fakebin, piLog);
  // Fake npm so installPiIfNeeded never hits the network. The fake npm copies a
  // template pi (reporting the pinned version) into the staged node_modules path.
  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, {
    npmLog,
    templatePiPath: join(templateDir, "pi"),
  });
  if (existingSupportFiles) {
    for (const [relativePath, content] of Object.entries(existingSupportFiles)) {
      const target = join(agentDir, "tlh", relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  if (existingManagedRtk) {
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    writeFileSync(join(agentDir, "bin", "rtk"), "#!/bin/sh\nexit 0\n");
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: `${fakebin}:${process.env.PATH || ""}`,
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
    ...envOverrides,
  });
  const args = ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper"];
  if (dryRun) args.unshift("--dry-run");
  if (noSettings) args.push("--no-settings");
  if (force) args.push("--force");
  if (verbose) args.push("--verbose");
  const result = runInstaller(args, env);
  return { result, homeDir, agentDir, binDir, piLog };
}
