/**
 * uninstall.sh removes the TLH Herdr.app program entry and icon folder.
 * Every run isolates HOME and HERDR_APP_HOME in temp dirs (never the real app home).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-uninstall-herdr-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = join(root, "home");
  const appHome = join(root, "app-home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(appHome, { recursive: true });
  return { root, homeDir, appHome };
}

function seedEntry(appHome, extra = {}) {
  const document = {
    version: 1,
    programs: { other: { name: "Other" }, tlh: { name: "TLH", icon: "tlh/tlh.svg" } },
    ...extra,
  };
  writeFileSync(join(appHome, "programs.json"), `${JSON.stringify(document, null, 2)}\n`);
  mkdirSync(join(appHome, "tlh"), { recursive: true });
  writeFileSync(join(appHome, "tlh", "tlh.svg"), "<svg/>");
}

function run(
  ctx,
  { args = [], path = [...SYSTEM_PATH, dirname(process.execPath)], env = {} } = {},
) {
  return spawnSync(
    "/bin/bash",
    [
      join(repoRoot, "uninstall.sh"),
      "--agent-dir",
      join(ctx.root, "profile", "agent"),
      "--bin-dir",
      join(ctx.root, "bin"),
      ...args,
    ],
    {
      cwd: repoRoot,
      env: { HOME: ctx.homeDir, HERDR_APP_HOME: ctx.appHome, PATH: path.join(delimiter), ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const readPrograms = (appHome) => JSON.parse(readFileSync(join(appHome, "programs.json"), "utf8"));
const backups = (appHome) =>
  readdirSync(appHome).filter((n) => n.startsWith("programs.json.backup-herdr-"));

test("removes programs.tlh and icon folder, preserving other data, with a backup", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome, { custom: { keep: true } });
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readPrograms(ctx.appHome), {
    version: 1,
    programs: { other: { name: "Other" } },
    custom: { keep: true },
  });
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
  const [backup] = backups(ctx.appHome);
  assert.equal(backups(ctx.appHome).length, 1);
  assert.equal(readFileSync(join(ctx.appHome, backup), "utf8"), before);
  assert.doesNotMatch(result.stdout, /Nothing to remove/);
});

test("keeps an emptied programs object and the app home", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome, { programs: { tlh: { name: "TLH" } } });
  assert.equal(run(ctx).status, 0);
  assert.deepEqual(readPrograms(ctx.appHome).programs, {});
  assert.equal(existsSync(ctx.appHome), true);
});

test("runs regardless of the herdrApp opt-out setting", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  const agentDir = join(ctx.root, "profile", "agent");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  writeFileSync(join(agentDir, "tlh", "install-state.json"), "{}");
  writeFileSync(join(agentDir, "settings.json"), '{"tlh":{"herdrApp":{"enabled":false}}}');
  assert.equal(run(ctx).status, 0);
  assert.equal(readPrograms(ctx.appHome).programs.tlh, undefined);
});

test("expands ~ and trims HERDR_APP_HOME; defaults to ~/.config/herdr-app", (t) => {
  const ctx = setup(t);
  const defaultHome = join(ctx.homeDir, ".config", "herdr-app");
  mkdirSync(defaultHome, { recursive: true });
  seedEntry(defaultHome);
  assert.equal(run(ctx, { env: { HERDR_APP_HOME: "" } }).status, 0);
  assert.equal(readPrograms(defaultHome).programs.tlh, undefined);

  const tildeHome = join(ctx.homeDir, "tilde-app");
  mkdirSync(tildeHome);
  seedEntry(tildeHome);
  assert.equal(run(ctx, { env: { HERDR_APP_HOME: "  ~/tilde-app  " } }).status, 0);
  assert.equal(readPrograms(tildeHome).programs.tlh, undefined);
});

test("no-op when app home, programs.json, or the key is absent", (t) => {
  const ctx = setup(t);
  let result = run(ctx, { env: { HERDR_APP_HOME: join(ctx.root, "missing") } });
  assert.equal(result.status, 0);
  assert.equal(existsSync(join(ctx.root, "missing")), false);
  assert.match(result.stdout, /Nothing to remove/);

  result = run(ctx);
  assert.equal(result.status, 0);
  assert.equal(existsSync(join(ctx.appHome, "programs.json")), false);

  const original = `${JSON.stringify({ programs: { other: { name: "O" } } })}\n`;
  writeFileSync(join(ctx.appHome, "programs.json"), original);
  result = run(ctx);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), original);
  assert.equal(backups(ctx.appHome).length, 0);
});

test("keeps a leftover icon folder, with a note, when the entry is already absent", (t) => {
  const ctx = setup(t);
  writeFileSync(join(ctx.appHome, "programs.json"), '{"programs":{}}');
  mkdirSync(join(ctx.appHome, "tlh"));
  writeFileSync(join(ctx.appHome, "tlh", "tlh.svg"), "<svg/>");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.match(result.stdout, /Leaving the Herdr\.app icon folder in place/);
  assert.equal(backups(ctx.appHome).length, 0);
});

test("keeps a leftover icon folder when programs.json is absent", (t) => {
  const ctx = setup(t);
  mkdirSync(join(ctx.appHome, "tlh"));
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(ctx.appHome, "tlh")), true);
});

test("removes only tlh.svg and keeps the folder when it holds foreign files", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  writeFileSync(join(ctx.appHome, "tlh", "mine.txt"), "keep");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), false);
  assert.equal(readFileSync(join(ctx.appHome, "tlh", "mine.txt"), "utf8"), "keep");
  assert.match(result.stdout, /Kept Herdr\.app icon folder \(not empty\)/);
});

function protectedCase(label, prepare) {
  test(`refuses a protected app home: ${label}`, (t) => {
    const ctx = setup(t);
    const target = prepare(ctx);
    const programs = join(target, "programs.json");
    const before = existsSync(programs) ? readFileSync(programs, "utf8") : undefined;
    const result = run(ctx, { env: { HERDR_APP_HOME: ctx.appHomeOverride ?? target } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /protected location/);
    assert.equal(existsSync(join(target, "tlh", "tlh.svg")), true);
    if (before !== undefined) assert.equal(readFileSync(programs, "utf8"), before);
    assert.equal(backups(target).length, 0);
  });
}

protectedCase("~/.pi/agent", (ctx) => {
  const dir = join(ctx.homeDir, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  seedEntry(dir);
  return dir;
});

protectedCase("symlinked ancestor into ~/.pi", (ctx) => {
  const dir = join(ctx.homeDir, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  seedEntry(dir);
  symlinkSync(join(ctx.homeDir, ".pi"), join(ctx.root, "alias"));
  ctx.appHomeOverride = join(ctx.root, "alias", "agent");
  return dir;
});

function symlinkedAgentCase(ctx) {
  const outside = join(ctx.root, "outside-agent");
  const child = join(outside, "child");
  mkdirSync(child, { recursive: true });
  seedEntry(child);
  mkdirSync(join(ctx.homeDir, ".pi"), { recursive: true });
  symlinkSync(outside, join(ctx.homeDir, ".pi", "agent"));
  return child;
}

protectedCase("symlinked ~/.pi/agent outside ~/.pi (via link)", (ctx) => {
  const child = symlinkedAgentCase(ctx);
  ctx.appHomeOverride = join(ctx.homeDir, ".pi", "agent", "child");
  return child;
});

protectedCase("symlinked ~/.pi/agent outside ~/.pi (resolved target)", symlinkedAgentCase);

protectedCase("$HOME itself", (ctx) => {
  seedEntry(ctx.homeDir);
  return ctx.homeDir;
});

protectedCase("inside the TLH profile root", (ctx) => {
  const dir = join(ctx.root, "profile", "runtime", "app");
  mkdirSync(dir, { recursive: true });
  seedEntry(dir);
  return dir;
});

test("--dry-run reports only", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx, { args: ["--dry-run"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would remove the TLH entry from Herdr\.app programs\.json/);
  assert.match(result.stdout, /would remove the TLH icon file: .*tlh\.svg/);
  assert.match(result.stdout, /icon folder only if it is empty/);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.equal(backups(ctx.appHome).length, 0);
});

for (const [label, content] of [
  ["invalid JSON", "{not json"],
  ["non-object root", "[]"],
  ["non-object programs", '{"programs":[]}'],
]) {
  test(`warns and leaves entry and icon untouched on ${label}`, (t) => {
    const ctx = setup(t);
    seedEntry(ctx.appHome);
    writeFileSync(join(ctx.appHome, "programs.json"), content);
    const result = run(ctx);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /warning: not editing Herdr\.app programs\.json/);
    assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), content);
    assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
    assert.equal(backups(ctx.appHome).length, 0);
  });
}

test("refuses a symlinked programs.json and keeps the icon", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  const real = join(ctx.root, "real-programs.json");
  writeFileSync(real, readFileSync(join(ctx.appHome, "programs.json")));
  rmSync(join(ctx.appHome, "programs.json"));
  symlinkSync(real, join(ctx.appHome, "programs.json"));
  const result = run(ctx);
  assert.match(result.stderr, /symlink/);
  assert.equal(readPrograms(ctx.appHome).programs.tlh.name, "TLH");
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
});

test("never removes through a symlinked icon folder", (t) => {
  const ctx = setup(t);
  writeFileSync(join(ctx.appHome, "programs.json"), '{"programs":{"tlh":{}}}');
  const outside = join(ctx.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "x");
  symlinkSync(outside, join(ctx.appHome, "tlh"));
  const result = run(ctx);
  assert.match(result.stderr, /icon folder: refusing to remove a symlink/);
  assert.equal(existsSync(join(outside, "keep.txt")), true);
  assert.equal(readPrograms(ctx.appHome).programs.tlh, undefined);
});

test("keeps the icon folder when the entry removal fails", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  // Read-only app home: the backup copy cannot be created, so the edit fails.
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  spawnSync("chmod", ["555", ctx.appHome]);
  let result;
  try {
    result = run(ctx);
  } finally {
    spawnSync("chmod", ["755", ctx.appHome]);
  }
  assert.match(result.stderr, /not editing Herdr\.app programs\.json/);
  assert.equal(readPrograms(ctx.appHome).programs.tlh.name, "TLH");
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
});

test("without node, leaves entry and icon and prints manual steps", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  if (
    spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: SYSTEM_PATH.join(delimiter) } })
      .status === 0
  ) {
    return t.skip("node is installed in a system path");
  }
  const result = run(ctx, { path: SYSTEM_PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /node not found on PATH/);
  assert.match(result.stderr, /only if .*"run" is exactly .* \(or absent\)/);
  assert.match(result.stderr, /not a symlink/);
  assert.match(result.stderr, /rmdir -- .*tlh.* if it is empty/);
  assert.equal(readPrograms(ctx.appHome).programs.tlh.name, "TLH");
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
});

function seedWithRun(ctx, runValue) {
  seedEntry(ctx.appHome);
  const doc = readPrograms(ctx.appHome);
  doc.programs.tlh.run = runValue;
  writeFileSync(join(ctx.appHome, "programs.json"), JSON.stringify(doc));
}

test("removes the entry when run is this install's wrapper", (t) => {
  const ctx = setup(t);
  seedWithRun(ctx, [join(ctx.root, "bin", "tlh")]);
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal("tlh" in readPrograms(ctx.appHome).programs, false);
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
});

test("keeps entry and icon, with a note, when another install owns run", (t) => {
  const ctx = setup(t);
  const other = join(ctx.root, "elsewhere", "tlh-main");
  seedWithRun(ctx, [other]);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.equal(backups(ctx.appHome).length, 0);
  assert.match(result.stdout, new RegExp(`owned by another install \\(run: ${other}\\)`));
});

test("a symlinked bin dir resolves equal to the physical wrapper path", (t) => {
  const ctx = setup(t);
  const realBin = join(ctx.root, "real-bin");
  mkdirSync(realBin);
  symlinkSync(realBin, join(ctx.root, "bin"));
  seedWithRun(ctx, [join(realBin, "tlh")]);
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal("tlh" in readPrograms(ctx.appHome).programs, false);
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
});

test("removes the entry when run is a symlink to this install's wrapper (wrapper still present at cleanup)", (t) => {
  const ctx = setup(t);
  const bin = join(ctx.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tlh"),
    "#!/usr/bin/env bash\n\n# Managed by The Last Harness installer\n",
  );
  const link = join(ctx.root, "alias-tlh");
  symlinkSync(join(bin, "tlh"), link);
  seedWithRun(ctx, [link]);
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(bin, "tlh")), false);
  assert.equal("tlh" in readPrograms(ctx.appHome).programs, false);
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
});

test("keeps entry and icon when run is a symlink to a foreign wrapper", (t) => {
  const ctx = setup(t);
  const bin = join(ctx.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tlh"),
    "#!/usr/bin/env bash\n\n# Managed by The Last Harness installer\n",
  );
  const foreign = join(ctx.root, "foreign-tlh");
  writeFileSync(foreign, "#!/bin/sh\n");
  const link = join(ctx.root, "alias-tlh");
  symlinkSync(foreign, link);
  seedWithRun(ctx, [link]);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(bin, "tlh")), false);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.match(result.stdout, /owned by another install/);
});

test("keeps entry and icon when run is a nonexistent foreign path", (t) => {
  const ctx = setup(t);
  const missing = join(ctx.root, "gone", "tlh");
  seedWithRun(ctx, [missing]);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.match(result.stdout, /owned by another install/);
});

test("Herdr cleanup runs before wrapper removal (run is the existing wrapper itself)", (t) => {
  const ctx = setup(t);
  const bin = join(ctx.root, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "tlh");
  writeFileSync(wrapper, "#!/usr/bin/env bash\n\n# Managed by The Last Harness installer\n");
  seedWithRun(ctx, [wrapper]);
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(wrapper), false);
  assert.equal("tlh" in readPrograms(ctx.appHome).programs, false);
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
});

test("keeps entry and icon when run uses alias/.. to collapse onto this wrapper lexically", (t) => {
  const ctx = setup(t);
  const bin = join(ctx.root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "tlh"),
    "#!/usr/bin/env bash\n\n# Managed by The Last Harness installer\n",
  );
  mkdirSync(join(ctx.root, "foreign", "nested"), { recursive: true });
  mkdirSync(join(ctx.root, "foreign", "bin"));
  writeFileSync(join(ctx.root, "foreign", "bin", "tlh"), "#!/bin/sh\n");
  symlinkSync(join(ctx.root, "foreign", "nested"), join(ctx.root, "alias"));
  seedWithRun(ctx, [`${ctx.root}/alias/../bin/tlh`]);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.match(result.stdout, /owned by another install/);
});

test("keeps entry and icon when run is a relative path", (t) => {
  const ctx = setup(t);
  seedWithRun(ctx, ["bin/tlh"]);
  const before = readFileSync(join(ctx.appHome, "programs.json"), "utf8");
  const result = run(ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ctx.appHome, "programs.json"), "utf8"), before);
  assert.equal(existsSync(join(ctx.appHome, "tlh", "tlh.svg")), true);
  assert.match(result.stdout, /owned by another install/);
});

test("removes the owned entry and icon through a symlinked app home", (t) => {
  const ctx = setup(t);
  seedEntry(ctx.appHome);
  const link = join(ctx.root, "app-home-link");
  symlinkSync(ctx.appHome, link);
  const result = run(ctx, { env: { HERDR_APP_HOME: link } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readPrograms(ctx.appHome), {
    version: 1,
    programs: { other: { name: "Other" } },
  });
  assert.equal(existsSync(join(ctx.appHome, "tlh")), false);
  assert.equal(backups(ctx.appHome).length, 1);
});
