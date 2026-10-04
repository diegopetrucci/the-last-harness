import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";
import {
  TLH_PINNED_PI_VERSION,
  runInstaller,
  safeInstallerPath,
  scrubInstallerEnv,
  seedRuntimeLock,
  writeFakeCommand,
  writeFakeNpmCiInstaller,
  writeFakePi,
  writeFakeTk,
  writeLoggingPi,
} from "./install-stage1-core-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Lockfile-based install (staged npm ci) tests — tlha-e7lp
// ---------------------------------------------------------------------------

test("lockfile install: fresh install creates bin/pi symlink and lib/package-lock.json", (t) => {
  const root = makeTempDir("tlh-install-lockfile-fresh-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const npmLog = join(root, "npm.log");
  const piLog = join(root, "pi.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // npm ci was called once.
  assert.deepEqual(readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
    "ci --ignore-scripts --no-audit --no-fund",
  ]);
  // bin/pi must exist (as a symlink or regular file after swap).
  const piBin = join(runtimeDir, "bin", "pi");
  assert.ok(existsSync(piBin), "bin/pi must exist after fresh install");
  // lib/package-lock.json must exist (came from staging dir via swap).
  assert.ok(
    existsSync(join(runtimeDir, "lib", "package-lock.json")),
    "lib/package-lock.json must exist after lockfile install",
  );
});

test("lockfile install: same version + differing lock triggers reinstall", (t) => {
  const root = makeTempDir("tlh-install-lockfile-lock-mismatch-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const npmLog = join(root, "npm.log");
  const piLog = join(root, "pi.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Pre-seed a valid pi at the pinned version but with a DIFFERENT lock.
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  mkdirSync(join(runtimeDir, "lib"), { recursive: true });
  writeFileSync(join(runtimeDir, "lib", "package-lock.json"), '{"different":"lock"}', "utf8");
  // Also write a valid ownership marker.
  const realRuntimeDir = realpathSync(runtimeDir);
  writeFileSync(
    join(runtimeDir, ".tlh-runtime-owned"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@earendil-works/pi-coding-agent",
      runtimeAbsPath: realRuntimeDir,
      origin: "created",
    }),
    "utf8",
  );

  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // npm ci must have been called (lock mismatch → reinstall).
  assert.ok(existsSync(npmLog), "npm must be called when lock differs");
  assert.deepEqual(
    readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean),
    ["ci --ignore-scripts --no-audit --no-fund"],
    "npm ci must be called for lock mismatch",
  );
  // The lock mismatch message is in verbose output; verify the install succeeded.
  assert.match(output, /Pinning local Pi runtime to 1\.0\.0/, "output must mention pinning");
});

test("lockfile install: global-layout runtime without lib/package-lock.json triggers reinstall", (t) => {
  const root = makeTempDir("tlh-install-lockfile-old-layout-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const npmLog = join(root, "npm.log");
  const piLog = join(root, "pi.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Pre-seed a valid pi at the pinned version WITHOUT lib/package-lock.json (old npm -g layout).
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  // No lib/package-lock.json — simulates old install that predates lockfile approach.
  const realRuntimeDir = realpathSync(runtimeDir);
  writeFileSync(
    join(runtimeDir, ".tlh-runtime-owned"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@earendil-works/pi-coding-agent",
      runtimeAbsPath: realRuntimeDir,
      origin: "created",
    }),
    "utf8",
  );

  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // npm ci must have been called (no lock file → reinstall).
  assert.ok(existsSync(npmLog), "npm must be called when lib/package-lock.json is absent");
  assert.deepEqual(
    readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean),
    ["ci --ignore-scripts --no-audit --no-fund"],
    "npm ci must be called for old-layout runtime without lockfile",
  );
});

test("lockfile install: matching version + identical lock reuses without npm", (t) => {
  const root = makeTempDir("tlh-install-lockfile-reuse-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Pre-seed a valid pi at the pinned version WITH matching lock file.
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  seedRuntimeLock(runtimeDir);
  const realRuntimeDir = realpathSync(runtimeDir);
  writeFileSync(
    join(runtimeDir, ".tlh-runtime-owned"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@earendil-works/pi-coding-agent",
      runtimeAbsPath: realRuntimeDir,
      origin: "created",
    }),
    "utf8",
  );

  // npm exits 97 on any call — must NOT be invoked.
  writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // npm must NOT be called when version + lock match.
  assert.equal(
    existsSync(npmLog),
    false,
    "npm must not be called when version and lock file both match",
  );
});

test("lockfile install: failed npm ci leaves previous runtime intact and no staging dir", (t) => {
  const root = makeTempDir("tlh-install-lockfile-npm-fail-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const piLog = join(root, "pi.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Pre-seed a valid pi at the pinned version with differing lock (triggers reinstall).
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  mkdirSync(join(runtimeDir, "lib"), { recursive: true });
  writeFileSync(join(runtimeDir, "lib", "package-lock.json"), '{"different":"lock"}', "utf8");
  const realRuntimeDir = realpathSync(runtimeDir);
  writeFileSync(
    join(runtimeDir, ".tlh-runtime-owned"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@earendil-works/pi-coding-agent",
      runtimeAbsPath: realRuntimeDir,
      origin: "created",
    }),
    "utf8",
  );
  const existingPiBinContent = "#!/bin/sh\nprintf '1.0.0\\n'\n";
  // Overwrite pi with simple script to check it remains after failure.
  writeFileSync(join(runtimeDir, "bin", "pi"), existingPiBinContent, "utf8");

  // npm ci fails.
  writeFakeCommand(fakebin, "npm", "printf 'npm ci failure\\n' >&2; exit 1");
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  // Installer must fail.
  assert.notEqual(result.status, 0, `expected failure on npm ci failure:\n${output}`);
  // Existing pi must still exist (rollback preserved it).
  assert.ok(existsSync(join(runtimeDir, "bin", "pi")), "bin/pi must survive npm ci failure");
  // No staging dir must remain.
  const stagingDirs = existsSync(runtimeDir)
    ? readdirSync(runtimeDir).filter((e) => e.startsWith(".tlh-runtime-staging-"))
    : [];
  assert.equal(stagingDirs.length, 0, `staging dirs must be cleaned up on failure: ${stagingDirs}`);
});

test("lockfile install: failed staged validation leaves previous runtime intact and no staging dir", (t) => {
  const root = makeTempDir("tlh-install-lockfile-staged-validation-fail-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Pre-seed a valid pi with differing lock (triggers reinstall).
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  mkdirSync(join(runtimeDir, "lib"), { recursive: true });
  writeFileSync(join(runtimeDir, "lib", "package-lock.json"), '{"different":"lock"}', "utf8");
  const realRuntimeDir = realpathSync(runtimeDir);
  writeFileSync(
    join(runtimeDir, ".tlh-runtime-owned"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@earendil-works/pi-coding-agent",
      runtimeAbsPath: realRuntimeDir,
      origin: "created",
    }),
    "utf8",
  );

  // Template pi reports wrong version (0.80.7) — staged validation will fail.
  writeFakePi(
    templateDir,
    'if [[ "${1:-}" == "--version" ]]; then printf \'0.80.7\\n\'; exit 0; fi\nexit 0',
  );
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  // Installer must fail (staged validation detected wrong version).
  assert.notEqual(result.status, 0, `expected failure on staged validation:\n${output}`);
  assert.match(output, /0\.80\.7/, "error must mention the wrong version");
  // Existing bin/pi must survive.
  assert.ok(
    existsSync(join(runtimeDir, "bin", "pi")),
    "bin/pi must survive staged validation failure",
  );
  // No staging dir must remain.
  const stagingDirs = existsSync(runtimeDir)
    ? readdirSync(runtimeDir).filter((e) => e.startsWith(".tlh-runtime-staging-"))
    : [];
  assert.equal(stagingDirs.length, 0, `staging dirs must be cleaned up on failure: ${stagingDirs}`);
});

test("lockfile install: migrated prefix with only TLH content is reconciled (swaps lib)", (t) => {
  const root = makeTempDir("tlh-install-lockfile-migrated-ok-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Old npm -g install layout: lib/node_modules has only TLH content, no package-lock.json.
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  mkdirSync(join(runtimeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), {
    recursive: true,
  });
  mkdirSync(join(runtimeDir, "lib", "node_modules", ".bin"), { recursive: true });
  // No lib/package-lock.json → triggers reinstall.
  // Install-state carries piInstalledByTlh=true → migrated origin.
  writeFileSync(
    join(agentDir, "tlh", "install-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      piInstalledByTlh: true,
    }),
    "utf8",
  );

  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // npm ci must have been called.
  assert.ok(existsSync(npmLog), "npm ci must be called for migrated prefix with TLH-only lib");
});

test("lockfile install: migrated prefix with foreign lib content refuses without changes", (t) => {
  const root = makeTempDir("tlh-install-lockfile-migrated-foreign-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // Old npm -g install layout WITH a foreign package in lib/node_modules.
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);
  mkdirSync(join(runtimeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), {
    recursive: true,
  });
  // Foreign package in node_modules.
  mkdirSync(join(runtimeDir, "lib", "node_modules", "some-foreign-tool"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "lib", "node_modules", "some-foreign-tool", "index.js"),
    "// foreign content\n",
    "utf8",
  );
  // Install-state carries piInstalledByTlh=true → migrated origin.
  writeFileSync(
    join(agentDir, "tlh", "install-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      piInstalledByTlh: true,
    }),
    "utf8",
  );

  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  // Must fail with an actionable message about content TLH does not own.
  assert.notEqual(result.status, 0, `expected failure on foreign lib content:\n${output}`);
  assert.match(output, /does not own/, "error must say entries TLH does not own");
  assert.match(output, /left.*unchanged/, "error must say prefix was left unchanged");
  assert.match(output, /some-foreign-tool/, "error must name the unrecognised entry");
  // Foreign content must be untouched.
  assert.ok(
    existsSync(join(runtimeDir, "lib", "node_modules", "some-foreign-tool", "index.js")),
    "foreign package content must be untouched",
  );
  // npm must NOT be called.
  assert.equal(existsSync(npmLog), false, "npm must not be called when foreign lib content exists");
});

test("lockfile install: dry-run prints planned actions and writes nothing", (t) => {
  const root = makeTempDir("tlh-install-lockfile-dryrun-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  // npm exits 98 on any call — must NOT be invoked in dry-run.
  writeFakeCommand(fakebin, "npm", "printf 'npm must not run in dry-run\\n' >&2; exit 98");
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // Dry-run must print the actual npm ci command (not the synthetic bash -c form).
  assert.match(
    output,
    /npm ci --ignore-scripts --no-audit --no-fund/,
    "dry-run must print exact npm ci command",
  );
  // The npm ci line must appear as a direct command (+ npm ci ...), not wrapped in bash -c.
  const npmCiLine = output.split(/\r?\n/).find((l) => l.includes("npm ci"));
  assert.ok(npmCiLine, "must find a line mentioning npm ci");
  assert.doesNotMatch(npmCiLine, /bash -c/, "npm ci must not appear inside a bash -c wrapper line");
  // Runtime dir must NOT have been created.
  assert.equal(existsSync(runtimeDir), false, "runtime dir must not be created in dry-run");
});

test("lockfile install: lib/ has no bin/ subdirectory after fresh install (Fix #2)", (t) => {
  const root = makeTempDir("tlh-install-lockfile-no-lib-bin-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const npmLog = join(root, "npm.log");
  const piLog = join(root, "pi.log");
  const runtimeDir = join(root, "runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  writeFakeCommand(fakebin, "git", "exit 0");
  writeFakeTk(fakebin);

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: safeInstallerPath(fakebin),
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-settings", "--no-wrapper"],
    env,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  // bin/pi must exist at the runtime prefix level (not inside lib/).
  assert.ok(existsSync(join(runtimeDir, "bin", "pi")), "runtime bin/pi must exist");
  // lib/bin must NOT exist — it would mean the staged bin dir leaked into lib after swap.
  assert.equal(
    existsSync(join(runtimeDir, "lib", "bin")),
    false,
    "lib/bin must not exist after staged swap (staged bin dir must be removed before swap)",
  );
});
