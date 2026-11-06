import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupHerdrPrograms } from "../scripts/lib/tlh-install-herdr-app.mjs";

import {
  TLH_PINNED_PI_VERSION,
  readJson,
  repoRoot,
  runInstaller,
  scrubInstallerEnv,
  writeFakeNpmCiInstaller,
  writeFakeTk,
  writeLoggingPi,
  assertHerdrAppHomeIsolated,
} from "./install-stage1-core-test-helpers.mjs";
import { makeTempDir } from "./install-stage1-test-helpers.mjs";

// The packaged icon the installer copies into the Herdr.app home.
const ICON_SOURCE = join(repoRoot, "config", "herdr", "tlh-mark.svg");

const EXPECTED_ENTRY = { name: "TLH", icon: "tlh/tlh.svg", tint: false };

function herdrBackupFiles(appHome) {
  if (!existsSync(appHome)) return [];
  return readdirSync(appHome).filter((name) => name.startsWith("programs.json.backup-"));
}

// writeFileAtomically() stages each write as ".<name>.<uuid>.tmp" in the target
// directory, so any survivor is a leaked temp file.
function herdrTempFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

/**
 * Build one isolated install fixture with a temporary HOME and a temporary
 * Herdr.app home. scrubInstallerEnv() removes HERDR_APP_HOME from the inherited
 * environment, so these tests can never reach a developer's real
 * ~/.config/herdr-app. `run()` may be called repeatedly against the same
 * directories to exercise rerun/idempotency behavior.
 */
function setupHerdrInstall(
  t,
  { appHome = "env", createAppHome = false, programsJson, appHomeRelativeToHome } = {},
) {
  const root = makeTempDir("tlh-install-herdr-app-test-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const packageDir = join(root, "package-source");
  const templateDir = join(root, "pi-template");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  for (const dir of [homeDir, packageDir, templateDir]) mkdirSync(dir, { recursive: true });
  writeFakeTk(fakebin);
  writeLoggingPi(fakebin, piLog);
  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  writeFakeNpmCiInstaller(fakebin, { npmLog, templatePiPath: join(templateDir, "pi") });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const appHomePath =
    appHomeRelativeToHome !== undefined
      ? join(homeDir, appHomeRelativeToHome)
      : appHome === "default"
        ? join(homeDir, ".config", "herdr-app")
        : join(root, "herdr-app");
  if (createAppHome) mkdirSync(appHomePath, { recursive: true });
  if (programsJson !== undefined) {
    mkdirSync(appHomePath, { recursive: true });
    writeFileSync(join(appHomePath, "programs.json"), programsJson);
  }

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: `${fakebin}:${process.env.PATH || ""}`,
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
    HERDR_APP_HOME:
      appHome === "default" && appHomeRelativeToHome === undefined ? undefined : appHomePath,
  });

  const run = ({ cliArgs = [], wrapper = false } = {}) => {
    // Repeated installer runs within the same second collide on the installer's
    // second-precision before-install settings backup. Clear those unrelated
    // artifacts so rerun tests stay focused on the Herdr.app step.
    if (existsSync(agentDir)) {
      for (const name of readdirSync(agentDir)) {
        if (name.startsWith("settings.json.backup-")) rmSync(join(agentDir, name), { force: true });
      }
    }
    const args = [...cliArgs, "--agent-dir", agentDir, "--bin-dir", binDir];
    if (!wrapper) args.push("--no-wrapper");
    return runInstaller(args, env);
  };

  return { run, root, homeDir, agentDir, binDir, appHomePath, env };
}

function assertInstalled(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("herdr: merges the TLH program entry and copies the icon into a TLH-owned subfolder", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  assertInstalled(fixture.run({ wrapper: true }));

  const programsPath = join(fixture.appHomePath, "programs.json");
  assert.equal(existsSync(programsPath), true);
  assert.deepEqual(readJson(programsPath).programs.tlh, {
    ...EXPECTED_ENTRY,
    run: [join(fixture.binDir, "tlh-main")],
  });

  const iconPath = join(fixture.appHomePath, "tlh", "tlh.svg");
  assert.equal(existsSync(iconPath), true);
  assert.equal(readFileSync(iconPath, "utf8"), readFileSync(ICON_SOURCE, "utf8"));

  // Nothing was overwritten, so nothing needed a backup.
  assert.deepEqual(herdrBackupFiles(fixture.appHomePath), []);
  // The atomic writes are renamed into place and leave no staging files behind.
  assert.deepEqual(herdrTempFiles(fixture.appHomePath), []);
  assert.deepEqual(herdrTempFiles(join(fixture.appHomePath, "tlh")), []);
});

test("herdr: preserves other entries and top-level keys and backs up before the first change", (t) => {
  const seeded = `${JSON.stringify(
    {
      programs: { lazygit: { name: "Git", tile: "#f05032" }, tool: { name: "Tool" } },
      shells: ["xonsh"],
      interpreters: ["pipx"],
    },
    null,
    2,
  )}\n`;
  const fixture = setupHerdrInstall(t, { createAppHome: true, programsJson: seeded });
  assertInstalled(fixture.run());

  const document = readJson(join(fixture.appHomePath, "programs.json"));
  assert.deepEqual(document.programs.lazygit, { name: "Git", tile: "#f05032" });
  assert.deepEqual(document.programs.tool, { name: "Tool" });
  assert.deepEqual(document.shells, ["xonsh"]);
  assert.deepEqual(document.interpreters, ["pipx"]);
  assert.deepEqual(document.programs.tlh, EXPECTED_ENTRY);

  const backups = herdrBackupFiles(fixture.appHomePath);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fixture.appHomePath, backups[0]), "utf8"), seeded);
});

test("herdr: rerun is a no-op and a user-edited or deleted programs.tlh is restored", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  assertInstalled(fixture.run());
  const programsPath = join(fixture.appHomePath, "programs.json");
  const afterFirst = readFileSync(programsPath, "utf8");

  // Second run: already current, so no rewrite and no backup.
  assertInstalled(fixture.run());
  assert.equal(readFileSync(programsPath, "utf8"), afterFirst);
  assert.deepEqual(herdrBackupFiles(fixture.appHomePath), []);

  // A user-modified entry is replaced wholesale, with a backup of the edit.
  const editedDocument = {
    ...readJson(programsPath),
    programs: { tlh: { name: "Something else" } },
  };
  writeFileSync(programsPath, `${JSON.stringify(editedDocument, null, 2)}\n`);
  const edited = readFileSync(programsPath, "utf8");
  assertInstalled(fixture.run());
  assert.deepEqual(readJson(programsPath).programs.tlh, EXPECTED_ENTRY);
  const backups = herdrBackupFiles(fixture.appHomePath);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fixture.appHomePath, backups[0]), "utf8"), edited);

  // A deleted entry is restored.
  const withoutEntry = { ...readJson(programsPath), programs: {} };
  writeFileSync(programsPath, `${JSON.stringify(withoutEntry, null, 2)}\n`);
  assertInstalled(fixture.run());
  assert.deepEqual(readJson(programsPath).programs.tlh, EXPECTED_ENTRY);

  // And it settles back to a no-op.
  const afterRestore = readFileSync(programsPath, "utf8");
  assertInstalled(fixture.run());
  assert.equal(readFileSync(programsPath, "utf8"), afterRestore);
});

test("herdr: invalid JSON or a non-object root is reported and left untouched", (t) => {
  for (const seeded of ['{ "programs": { "tlh": ', "[]", '"text"', "null"]) {
    const fixture = setupHerdrInstall(t, { createAppHome: true, programsJson: seeded });
    const result = fixture.run();
    assertInstalled(result);
    assert.match(
      result.stderr,
      /skipping Herdr\.app program entry:/,
      `expected a skip warning for seeded content: ${seeded}`,
    );
    assert.equal(readFileSync(join(fixture.appHomePath, "programs.json"), "utf8"), seeded);
    assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
    assert.deepEqual(herdrBackupFiles(fixture.appHomePath), []);
  }
});

test("herdr: a non-object programs value is reported and left untouched", (t) => {
  const seeded = '{ "programs": [] }\n';
  const fixture = setupHerdrInstall(t, { createAppHome: true, programsJson: seeded });
  const result = fixture.run();
  assertInstalled(result);
  assert.match(result.stderr, /"programs" is not an object/);
  assert.equal(readFileSync(join(fixture.appHomePath, "programs.json"), "utf8"), seeded);
});

test("herdr: an absent app home is never created", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: false });
  const result = fixture.run();
  assertInstalled(result);
  assert.match(result.stdout, /Skipping Herdr\.app program entry \(app home not found:/);
  assert.equal(existsSync(fixture.appHomePath), false);
});

test("herdr: falls back to ~/.config/herdr-app when HERDR_APP_HOME is unset", (t) => {
  const fixture = setupHerdrInstall(t, { appHome: "default", createAppHome: true });
  assertInstalled(fixture.run());
  assert.equal(fixture.appHomePath.endsWith(".config/herdr-app"), true);
  assert.deepEqual(
    readJson(join(fixture.appHomePath, "programs.json")).programs.tlh,
    EXPECTED_ENTRY,
  );
  assert.equal(existsSync(join(fixture.appHomePath, "tlh", "tlh.svg")), true);
});

test("herdr: --dry-run reports the planned write and writes nothing", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  const result = fixture.run({ cliArgs: ["--dry-run"] });
  assertInstalled(result);
  assert.match(result.stdout, /Would copy the TLH icon into the Herdr\.app home:/);
  assert.match(
    result.stdout,
    /Would merge the TLH program entry into the Herdr\.app programs\.json:/,
  );
  assert.equal(existsSync(join(fixture.appHomePath, "programs.json")), false);
  assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
});

test("herdr: --dry-run reports the skip when the app home is absent", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: false });
  const result = fixture.run({ cliArgs: ["--dry-run"] });
  assertInstalled(result);
  assert.match(result.stdout, /Skipping Herdr\.app program entry \(app home not found:/);
  assert.equal(existsSync(fixture.appHomePath), false);
});

test("herdr: --no-wrapper omits run and --no-settings still merges the entry", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  const result = fixture.run();
  assertInstalled(result);
  assert.deepEqual(
    readJson(join(fixture.appHomePath, "programs.json")).programs.tlh,
    EXPECTED_ENTRY,
  );
});

test("herdr: rewrites programs.json atomically, preserving its mode", (t) => {
  const seeded = `${JSON.stringify({ programs: { tool: { name: "Tool" } } }, null, 2)}\n`;
  const fixture = setupHerdrInstall(t, { createAppHome: true, programsJson: seeded });
  const programsPath = join(fixture.appHomePath, "programs.json");
  // 0o660 makes the assertion umask-sensitive: a plain writeFileSync would apply
  // the process umask (typically 0o022) and drop group write.
  chmodSync(programsPath, 0o660);
  assert.equal(fileMode(programsPath), 0o660);

  assertInstalled(fixture.run());

  // The entry was merged by a temp-file + rename, so the seeded mode carries over
  // and no staging file survives in either directory TLH writes to.
  assert.deepEqual(readJson(programsPath).programs.tlh, EXPECTED_ENTRY);
  assert.equal(fileMode(programsPath), 0o660);
  assert.deepEqual(herdrTempFiles(fixture.appHomePath), []);
  assert.deepEqual(herdrTempFiles(join(fixture.appHomePath, "tlh")), []);
});

test("herdr: a symlinked TLH icon directory is refused and nothing is written outside the app home", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  const outsideDir = join(fixture.root, "outside");
  mkdirSync(outsideDir, { recursive: true });
  symlinkSync(outsideDir, join(fixture.appHomePath, "tlh"));

  const result = fixture.run();

  assertInstalled(result);
  assert.match(
    result.stderr,
    /skipping Herdr\.app program entry: refusing to write through a symlink/,
  );
  // The whole Herdr step is skipped, so programs.json is not created either.
  assert.equal(existsSync(join(fixture.appHomePath, "programs.json")), false);
  // Nothing escaped through the symlink into the target directory, and the
  // symlink itself is left in place.
  assert.deepEqual(readdirSync(outsideDir), []);
  assert.equal(lstatSync(join(fixture.appHomePath, "tlh")).isSymbolicLink(), true);
  assert.equal(statSync(join(fixture.appHomePath, "tlh")).isDirectory(), true);
});

test("herdr: a non-directory TLH icon path is skipped with a warning", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  // A regular file where TLH needs its icon folder.
  writeFileSync(join(fixture.appHomePath, "tlh"), "not a directory");

  const result = fixture.run();

  assertInstalled(result);
  assert.match(
    result.stderr,
    /skipping Herdr\.app program entry: .*tlh exists and is not a directory/,
  );
  assert.equal(existsSync(join(fixture.appHomePath, "programs.json")), false);
  assert.deepEqual(herdrTempFiles(fixture.appHomePath), []);
  assert.equal(readFileSync(join(fixture.appHomePath, "tlh"), "utf8"), "not a directory");
});

test("herdr: the packaged icon copy matches the brand source mark", () => {
  // docs/brand is excluded from the npm package, so config/herdr/ carries the
  // shipped copy. Keep the two byte-identical so a brand update cannot ship a
  // stale icon.
  assert.equal(
    readFileSync(ICON_SOURCE, "utf8"),
    readFileSync(join(repoRoot, "docs", "brand", "tlh-mark-dark.svg"), "utf8"),
  );
});

test("herdr: tlh.herdrApp.enabled=false in isolated settings skips and never removes an entry", (t) => {
  const existing = `${JSON.stringify({ programs: { tlh: { name: "Old" } } }, null, 2)}\n`;
  const fixture = setupHerdrInstall(t, { createAppHome: true, programsJson: existing });
  mkdirSync(fixture.agentDir, { recursive: true });
  writeFileSync(
    join(fixture.agentDir, "settings.json"),
    `${JSON.stringify({ tlh: { herdrApp: { enabled: false } } })}\n`,
  );
  const result = fixture.run({ cliArgs: ["--no-settings"] });
  assertInstalled(result);
  assert.match(
    result.stdout,
    /Skipping Herdr\.app program entry \(tlh\.herdrApp\.enabled is false/,
  );
  assert.equal(readFileSync(join(fixture.appHomePath, "programs.json"), "utf8"), existing);
  assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
  assert.deepEqual(herdrBackupFiles(fixture.appHomePath), []);
});

test("herdr: a symlinked programs.json is refused", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  const target = join(fixture.root, "real-programs.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(fixture.appHomePath, "programs.json"));
  const result = fixture.run();
  assertInstalled(result);
  assert.match(result.stderr, /refusing to write through a symlink/);
  assert.equal(readFileSync(target, "utf8"), "{}\n");
});

test("herdr: empty file, BOM-prefixed file, and non-directory app home", (t) => {
  const empty = setupHerdrInstall(t, { createAppHome: true, programsJson: "" });
  assertInstalled(empty.run());
  assert.deepEqual(readJson(join(empty.appHomePath, "programs.json")).programs.tlh, EXPECTED_ENTRY);

  const bom = setupHerdrInstall(t, {
    createAppHome: true,
    programsJson: `\uFEFF${JSON.stringify({ shells: ["x"] })}`,
  });
  assertInstalled(bom.run());
  const doc = readJson(join(bom.appHomePath, "programs.json"));
  assert.deepEqual(doc.shells, ["x"]);
  assert.deepEqual(doc.programs.tlh, EXPECTED_ENTRY);

  const file = setupHerdrInstall(t);
  writeFileSync(file.appHomePath, "not a dir");
  const result = file.run();
  assertInstalled(result);
  assert.match(result.stderr, /app home is not a directory/);
  assert.equal(readFileSync(file.appHomePath, "utf8"), "not a dir");
});

function runStage0DryRun(t, { herdrAppHome, createDir, beforeRun }) {
  const root = makeTempDir("tlh-install-herdr-stage0-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const target = join(home, "herdr dir");
  if (createDir) mkdirSync(target, { recursive: true });
  beforeRun?.(home);
  const env = scrubInstallerEnv({ HOME: home, HERDR_APP_HOME: herdrAppHome(home) });
  // `bash -s` with the script on stdin has no local checkout, so it takes the
  // stage-0 dry_run_without_stage1 path.
  const result = spawnSync(
    "bash",
    ["-s", "--", "--dry-run", "--agent-dir", join(root, "agent"), "--bin-dir", join(root, "bin")],
    { cwd: repoRoot, env, encoding: "utf8", input: readFileSync(join(repoRoot, "install.sh")) },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Bootstrap-level/);
  assert.equal(existsSync(join(target, "programs.json")), false);
  return { out: result.stdout, target, home };
}

test("herdr: stage-0 dry-run expands ~ and trims whitespace in HERDR_APP_HOME", (t) => {
  const expected = /Would merge the TLH program entry[^\n]*home\/herdr dir\/programs\.json/;
  const tilde = runStage0DryRun(t, { herdrAppHome: () => "~/herdr dir", createDir: true });
  assert.match(tilde.out, expected);
  const padded = runStage0DryRun(t, { herdrAppHome: (h) => `  ${h}/herdr dir  `, createDir: true });
  assert.match(padded.out, expected);
  const missing = runStage0DryRun(t, { herdrAppHome: () => "~/herdr dir", createDir: false });
  assert.match(missing.out, /Would skip the Herdr\.app program entry: app home not found/);
  assert.equal(existsSync(missing.target), false);
});

test("herdr: stage-0 dry-run skips a protected app home under ~/.pi without writing", (t) => {
  const protectedRun = runStage0DryRun(t, {
    herdrAppHome: (h) => `${h}/.pi/agent`,
    createDir: false,
    beforeRun: (h) => mkdirSync(join(h, ".pi", "agent"), { recursive: true }),
  });
  assert.match(
    protectedRun.out,
    /Would skip the Herdr\.app program entry: protected location \(.*\.pi\/agent\)/,
  );
  assert.doesNotMatch(protectedRun.out, /Would merge the TLH program entry/);
  assert.deepEqual(readdirSync(join(protectedRun.home, ".pi", "agent")), []);
});

test("herdr: test env helpers never resolve HERDR_APP_HOME under the real user home", () => {
  const realHome = userInfo().homedir;
  const inherited = { HERDR_APP_HOME: join(realHome, ".config", "herdr-app") };
  // An inherited real app home is dropped and replaced with a temp-side path.
  const env = scrubInstallerEnv({ HOME: join(tmpdir(), "tlh-fake-home") }, inherited);
  assert.equal(env.HERDR_APP_HOME, join(tmpdir(), "tlh-fake-home", ".config", "herdr-app"));
  assert.doesNotThrow(() => assertHerdrAppHomeIsolated(env));
  assert.doesNotThrow(() => assertHerdrAppHomeIsolated(scrubInstallerEnv({}, inherited)));
  // The guard rejects explicit and implicit real-home app homes.
  assert.throws(() => assertHerdrAppHomeIsolated(inherited), /real Herdr\.app home/);
  assert.throws(() => assertHerdrAppHomeIsolated({ HOME: realHome }), /real Herdr\.app home/);
  assert.throws(() => scrubInstallerEnv({ HERDR_APP_HOME: join(realHome, "x") }), /real Herdr/);
});

test("herdr: backups are exclusive and never overwrite an existing file", (t) => {
  const dir = makeTempDir("herdr-backup-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const programs = join(dir, "programs.json");
  writeFileSync(programs, "current");
  const date = new Date("2030-01-02T03:04:05.678Z");
  const first = backupHerdrPrograms(programs, date);
  writeFileSync(first, "precious");
  const second = backupHerdrPrograms(programs, date);
  assert.notEqual(second, first);
  assert.equal(readFileSync(first, "utf8"), "precious");
  assert.equal(readFileSync(second, "utf8"), "current");
});

test("herdr: an app home removed before the write is not recreated", (t) => {
  const fixture = setupHerdrInstall(t, { createAppHome: true });
  rmSync(fixture.appHomePath, { recursive: true, force: true });
  const result = fixture.run();
  assertInstalled(result);
  assert.equal(existsSync(fixture.appHomePath), false);
});

for (const [label, relative] of [
  ["under ~/.pi", ".pi/agent"],
  ["equal to $HOME", ""],
]) {
  test(`herdr: a protected app home (${label}) is skipped with a warning and nothing is written`, (t) => {
    const fixture = setupHerdrInstall(t, { appHomeRelativeToHome: relative, createAppHome: true });
    writeFileSync(join(fixture.appHomePath, "programs.json"), '{"programs":{}}');
    const result = fixture.run();
    assertInstalled(result);
    assert.match(result.stderr, /skipping Herdr\.app program entry: app home .* is protected/);
    assert.equal(
      readFileSync(join(fixture.appHomePath, "programs.json"), "utf8"),
      '{"programs":{}}',
    );
    assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
    assert.deepEqual(herdrBackupFiles(fixture.appHomePath), []);
  });
}

test("herdr: an app home inside the agent dir is skipped even when the agent dir is $HOME", (t) => {
  const fixture = setupHerdrInstall(t, {
    appHomeRelativeToHome: "herdr-inside",
    createAppHome: true,
  });
  const result = runInstaller(
    ["--agent-dir", fixture.homeDir, "--bin-dir", fixture.binDir, "--no-wrapper"],
    fixture.env,
  );
  assert.match(result.stderr, /is protected/, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(fixture.appHomePath, "programs.json")), false);
  assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
});

test("herdr: an app home reached through a symlink into ~/.pi is skipped", (t) => {
  const fixture = setupHerdrInstall(t, { appHomeRelativeToHome: ".pi/agent", createAppHome: true });
  const link = join(fixture.root, "alias");
  symlinkSync(fixture.appHomePath, link);
  const result = runInstaller(
    ["--agent-dir", fixture.agentDir, "--bin-dir", fixture.binDir, "--no-wrapper"],
    { ...fixture.env, HERDR_APP_HOME: join(link, "..", "alias") },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /is protected/);
  assert.equal(existsSync(join(fixture.appHomePath, "tlh")), false);
});

for (const viaLink of [true, false]) {
  test(`herdr: a symlinked ~/.pi/agent pointing outside ~/.pi is protected (${viaLink ? "via link" : "resolved target"})`, (t) => {
    const fixture = setupHerdrInstall(t, { createAppHome: false });
    const outside = join(fixture.root, "outside-agent");
    const child = join(outside, "child");
    mkdirSync(child, { recursive: true });
    mkdirSync(join(fixture.homeDir, ".pi"), { recursive: true });
    symlinkSync(outside, join(fixture.homeDir, ".pi", "agent"));
    const appHome = viaLink ? join(fixture.homeDir, ".pi", "agent", "child") : child;
    const result = runInstaller(
      ["--agent-dir", fixture.agentDir, "--bin-dir", fixture.binDir, "--no-wrapper"],
      { ...fixture.env, HERDR_APP_HOME: appHome },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /is protected/);
    assert.equal(existsSync(join(child, "programs.json")), false);
    assert.equal(existsSync(join(child, "tlh")), false);
  });
}
