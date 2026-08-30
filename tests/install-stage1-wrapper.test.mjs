import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";
import {
  TLH_NON_PINNED_PI_VERSION,
  TLH_PINNED_PI_VERSION,
  escapeRegExp,
  repoRoot,
  runHelper,
  runInstaller,
  scrubInstallerEnv,
  writeFakeCommand,
  writeFakeNpmInstaller,
  writeFakePi,
  writeFakeTk,
  writeLoggingPi,
  writeVersionedWrapperPi,
  writeWrapperHelperLogger,
} from "./install-stage1-core-test-helpers.mjs";

import { buildInstallConfig, parseArgs } from "../scripts/tlh-install.mjs";
import { renderShellWords } from "../scripts/lib/tlh-install-utils.mjs";

test("wrapper skips stale fallback package helpers for unlocatable custom sources", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const updateLog = join(root, "update.json");
  const defaultsLog = join(root, "defaults.json");
  const ticketsLog = join(root, "tickets.json");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = scrubInstallerEnv(
    {
      HOME: homeDir,
      TLH_PACKAGE_SOURCE: "github:owner/repo",
    },
    {
      ...process.env,
      PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
      TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
      TLH_REPO: "poisoned/repo",
      TLH_REF: "poisoned-ref",
    },
  );
  const config = buildInstallConfig(
    parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env),
    env,
  );

  writeWrapperHelperLogger(
    join(config.packageRoot, "scripts", "tlh-update.mjs"),
    "TLH_UPDATE_LOG",
    "stale-package",
  );
  writeWrapperHelperLogger(
    join(config.packageRoot, "scripts", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "stale-package",
  );
  writeWrapperHelperLogger(
    join(config.packageRoot, "scripts", "tlh-tickets.mjs"),
    "TLH_TICKETS_LOG",
    "stale-package",
  );
  mkdirSync(join(config.packageRoot, "config"), { recursive: true });
  writeFileSync(
    join(config.packageRoot, "config", "default-extensions.json"),
    '[\n  "stale-package"\n]\n',
    "utf8",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "recover-update.mjs"),
    "TLH_UPDATE_LOG",
    "recovery",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-update.mjs"),
    "TLH_UPDATE_LOG",
    "legacy-profile",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "legacy-profile",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-tickets.mjs"),
    "TLH_TICKETS_LOG",
    "legacy-profile",
  );
  writeFileSync(
    join(agentDir, "tlh", "default-extensions.json"),
    '[\n  "legacy-profile"\n]\n',
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      config.agentDir,
      "--bin-dir",
      config.binDir,
      "--wrapper-name",
      config.wrapperName,
      `--package-root=${config.packageHelperRoot}`,
    ],
    { homeDir },
  );
  const wrapper = readFileSync(config.wrapperPath, "utf8");
  assert.ok(wrapper.split(/\r?\n/).includes("default_tlh_package_root=''"));

  const wrapperEnv = scrubInstallerEnv({
    HOME: homeDir,
    PATH: process.env.PATH || "",
    TLH_UPDATE_LOG: updateLog,
    TLH_DEFAULTS_LOG: defaultsLog,
    TLH_TICKETS_LOG: ticketsLog,
  });
  const wrapperPath = join(binDir, config.wrapperName);

  const updateResult = spawnSync(wrapperPath, ["update", "--dry-run"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(updateResult.status, 0, updateResult.stderr);
  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  assert.equal(updateRecord.source, "recovery");

  const defaultsResult = spawnSync(wrapperPath, ["defaults", "list"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(defaultsResult.status, 1);
  assert.match(
    defaultsResult.stderr,
    /tlh defaults package support files are missing or corrupt; run `tlh update` to recover\./,
  );
  assert.doesNotMatch(defaultsResult.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(existsSync(defaultsLog), false);

  const ticketsResult = spawnSync(wrapperPath, ["tickets", "status"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(ticketsResult.status, 1);
  assert.match(
    ticketsResult.stderr,
    /tlh tickets package support files are missing or corrupt; run `tlh update` to recover\./,
  );
  assert.doesNotMatch(ticketsResult.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(existsSync(ticketsLog), false);
});

test("wrapper uses original node for helpers while exposing isolated bin only for tickets and pi", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const agentBinLink = join(root, "agent-bin-link");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const fakebin = join(root, "fakebin");
  const cwdDir = join(root, "cwd");
  const cwdLink = join(root, "cwd-link");
  const updateLog = join(root, "update.json");
  const ticketsLog = join(root, "tickets.json");
  const piLog = join(root, "pi.txt");
  const fakeNodeLog = join(root, "fake-node.log");
  const currentNodeLog = join(root, "current-node.log");
  const currentPiLog = join(root, "current-pi.log");
  const isolatedPiLog = join(root, "isolated-pi.log");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(agentBin, agentBinLink, "dir");
    symlinkSync(cwdDir, cwdLink, "dir");
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakeCommand(
    agentBin,
    "node",
    "printf 'isolated node intercepted\\n' >\"${FAKE_NODE_LOG}\"\nexit 88",
  );
  writeFakeCommand(
    agentBin,
    "tk",
    'if [[ "${1:-}" == "help" ]]; then printf \'isolated tk help\\n\'; exit 0; fi\nexit 1',
  );
  writeFakeCommand(
    agentBin,
    "pi",
    "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89",
  );
  writeFakeCommand(
    cwdDir,
    "node",
    "printf 'current-dir node intercepted\\n' >\"${CURRENT_NODE_LOG}\"\nexit 87",
  );
  writeFakeCommand(
    cwdDir,
    "pi",
    "printf 'current-dir pi intercepted\\n' >\"${CURRENT_PI_LOG}\"\nexit 86",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "recover-update.mjs"),
    "TLH_UPDATE_LOG",
    "recovery",
  );
  writeFileSync(
    join(packageRoot, "scripts", "tlh-tickets.mjs"),
    `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`,
    "utf8",
  );
  writeVersionedWrapperPi(fakebin, piLog);

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(fakebin, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const poisonedPathEntries = ["", ".", cwdDir, agentBin];
  if (process.platform !== "win32") poisonedPathEntries.push(cwdLink, agentBinLink);
  poisonedPathEntries.push(fakebin, process.env.PATH || "");
  const wrapperEnv = scrubInstallerEnv({
    HOME: homeDir,
    PATH: poisonedPathEntries.join(":"),
    TLH_UPDATE_LOG: updateLog,
    TLH_TICKETS_LOG: ticketsLog,
    PI_WRAPPER_LOG: piLog,
    FAKE_NODE_LOG: fakeNodeLog,
    CURRENT_NODE_LOG: currentNodeLog,
    CURRENT_PI_LOG: currentPiLog,
    ISOLATED_PI_LOG: isolatedPiLog,
  });

  const updateResult = spawnSync(wrapper, ["update", "--dry-run"], {
    cwd: cwdDir,
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(updateResult.status, 0, updateResult.stderr);
  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  assert.deepEqual(updateRecord.argv, [
    "--agent-dir",
    agentDir,
    "--bin-dir",
    binDir,
    "--wrapper-name",
    "tlh",
    "--dry-run",
  ]);
  assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);
  const updatePathEntries = updateRecord.env.PATH.split(":");
  assert.equal(updatePathEntries[0], fakebin);
  assert.equal(updatePathEntries.includes(""), false);
  assert.equal(updatePathEntries.includes("."), false);
  assert.equal(updatePathEntries.includes(cwdDir), false);
  assert.equal(updatePathEntries.includes(agentBin), false);
  if (process.platform !== "win32") {
    assert.equal(updatePathEntries.includes(cwdLink), false);
    assert.equal(updatePathEntries.includes(agentBinLink), false);
  }
  assert.equal(existsSync(currentNodeLog), false);
  assert.equal(existsSync(fakeNodeLog), false);

  const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
    cwd: cwdDir,
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
  const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
  assert.deepEqual(ticketsRecord.argv, [
    "--settings",
    join(agentDir, "settings.json"),
    "--agent-dir",
    agentDir,
    "--wrapper-name",
    "tlh",
    "status",
  ]);
  assert.equal(ticketsRecord.env.PI_CODING_AGENT_DIR, agentDir);
  const ticketsPathEntries = ticketsRecord.env.PATH.split(":");
  assert.deepEqual(ticketsPathEntries.slice(0, 2), [agentBin, fakebin]);
  assert.equal(ticketsPathEntries.includes(""), false);
  assert.equal(ticketsPathEntries.includes("."), false);
  assert.equal(ticketsPathEntries.includes(cwdDir), false);
  if (process.platform !== "win32") {
    assert.equal(ticketsPathEntries.includes(cwdLink), false);
    assert.equal(ticketsPathEntries.includes(agentBinLink), false);
  }
  assert.equal(ticketsRecord.tk.status, 0);
  assert.equal(ticketsRecord.tk.stdout, "isolated tk help");
  assert.equal(existsSync(fakeNodeLog), false);

  const piResult = spawnSync(wrapper, ["chat", "--version"], {
    cwd: cwdDir,
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(piResult.status, 0, piResult.stderr);
  const piRecord = Object.fromEntries(
    readFileSync(piLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(piRecord.argv, "chat --version");
  assert.equal(piRecord.agent, agentDir);
  const piPathEntries = piRecord.path.split(":");
  assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, fakebin]);
  assert.equal(piPathEntries.includes(""), false);
  assert.equal(piPathEntries.includes("."), false);
  assert.equal(piPathEntries.includes(cwdDir), false);
  if (process.platform !== "win32") {
    assert.equal(piPathEntries.includes(cwdLink), false);
    assert.equal(piPathEntries.includes(agentBinLink), false);
  }
  assert.equal(existsSync(currentPiLog), false);
  assert.equal(existsSync(isolatedPiLog), false);
  assert.equal(existsSync(currentNodeLog), false);
  assert.equal(existsSync(fakeNodeLog), false);
});

test("wrapper defaults and tickets helpers do not invoke PATH pi", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const fakebin = join(root, "fakebin");
  const defaultsLog = join(root, "defaults.json");
  const ticketsLog = join(root, "tickets.json");
  const piProbeLog = join(root, "pi-probe.log");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(join(packageRoot, "config"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakePi(
    agentBin,
    `printf 'managed:%s\n' "$*" >>"${piProbeLog}"
exit 63`,
  );
  writeFakeCommand(
    agentBin,
    "tk",
    'if [[ "${1:-}" == "help" ]]; then printf \'isolated tk help\\n\'; exit 0; fi\nexit 1',
  );
  writeFakePi(
    fakebin,
    `printf 'path:%s\n' "$*" >>"${piProbeLog}"
exit 64`,
  );
  writeWrapperHelperLogger(
    join(packageRoot, "scripts", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "package",
  );
  writeFileSync(join(packageRoot, "config", "default-extensions.json"), "[]\n", "utf8");
  writeFileSync(
    join(packageRoot, "scripts", "tlh-tickets.mjs"),
    `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const wrapperEnv = scrubInstallerEnv({
    HOME: homeDir,
    PATH: [fakebin, agentBin, process.env.PATH || ""].join(":"),
    TLH_DEFAULTS_LOG: defaultsLog,
    TLH_TICKETS_LOG: ticketsLog,
  });

  const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  const defaultsRecord = JSON.parse(readFileSync(defaultsLog, "utf8"));
  assert.deepEqual(defaultsRecord.argv, [
    "--settings",
    join(agentDir, "settings.json"),
    "--defaults",
    join(packageRoot, "config", "default-extensions.json"),
    "list",
  ]);
  assert.equal(defaultsRecord.env.PI_CODING_AGENT_DIR, agentDir);
  const defaultsPathEntries = defaultsRecord.env.PATH.split(":");
  assert.equal(defaultsPathEntries[0], fakebin);
  assert.equal(defaultsPathEntries.includes(agentBin), false);
  assert.equal(existsSync(piProbeLog), false);

  const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
  const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
  assert.deepEqual(ticketsRecord.argv, [
    "--settings",
    join(agentDir, "settings.json"),
    "--agent-dir",
    agentDir,
    "--wrapper-name",
    "tlh",
    "status",
  ]);
  assert.equal(ticketsRecord.env.PI_CODING_AGENT_DIR, agentDir);
  const ticketsPathEntries = ticketsRecord.env.PATH.split(":");
  assert.deepEqual(ticketsPathEntries.slice(0, 2), [agentBin, fakebin]);
  assert.equal(ticketsRecord.tk.status, 0);
  assert.equal(ticketsRecord.tk.stdout, "isolated tk help");
  assert.equal(existsSync(piProbeLog), false);
});

test("wrapper prefers package checkout helpers over profile copies", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const updateLog = join(root, "update.json");
  const defaultsLog = join(root, "defaults.json");
  const ticketsLog = join(root, "tickets.json");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(join(packageRoot, "config"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeWrapperHelperLogger(
    join(packageRoot, "scripts", "tlh-update.mjs"),
    "TLH_UPDATE_LOG",
    "package",
  );
  writeWrapperHelperLogger(
    join(packageRoot, "scripts", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "package",
  );
  writeWrapperHelperLogger(
    join(packageRoot, "scripts", "tlh-tickets.mjs"),
    "TLH_TICKETS_LOG",
    "package",
  );
  writeFileSync(
    join(packageRoot, "config", "default-extensions.json"),
    '[\n  "package"\n]\n',
    "utf8",
  );
  writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-update.mjs"), "TLH_UPDATE_LOG", "profile");
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "profile",
  );
  writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "profile");
  writeFileSync(join(agentDir, "tlh", "default-extensions.json"), '[\n  "profile"\n]\n', "utf8");

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const wrapperEnv = scrubInstallerEnv({
    HOME: homeDir,
    PATH: process.env.PATH || "",
    TLH_UPDATE_LOG: updateLog,
    TLH_DEFAULTS_LOG: defaultsLog,
    TLH_TICKETS_LOG: ticketsLog,
  });

  const updateResult = spawnSync(wrapper, ["update", "--dry-run"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(updateResult.status, 0, updateResult.stderr);
  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  assert.equal(updateRecord.source, "package");
  assert.deepEqual(updateRecord.argv, [
    "--agent-dir",
    agentDir,
    "--bin-dir",
    binDir,
    "--wrapper-name",
    "tlh",
    "--dry-run",
  ]);

  const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  const defaultsRecord = JSON.parse(readFileSync(defaultsLog, "utf8"));
  assert.equal(defaultsRecord.source, "package");
  assert.deepEqual(defaultsRecord.argv, [
    "--settings",
    join(agentDir, "settings.json"),
    "--defaults",
    join(packageRoot, "config", "default-extensions.json"),
    "list",
  ]);

  const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
  const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
  assert.equal(ticketsRecord.source, "package");
  assert.deepEqual(ticketsRecord.argv, [
    "--settings",
    join(agentDir, "settings.json"),
    "--agent-dir",
    agentDir,
    "--wrapper-name",
    "tlh",
    "status",
  ]);
});

test("wrapper ignores stale profile defaults/tickets helpers when package helper transitive imports are corrupt", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const defaultsLog = join(root, "defaults.json");
  const ticketsLog = join(root, "tickets.json");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(packageRoot, "scripts", "lib"), { recursive: true });
  mkdirSync(join(packageRoot, "config"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-defaults.mjs"),
    "TLH_DEFAULTS_LOG",
    "legacy-profile",
  );
  writeWrapperHelperLogger(
    join(agentDir, "tlh", "tlh-tickets.mjs"),
    "TLH_TICKETS_LOG",
    "legacy-profile",
  );
  writeFileSync(
    join(agentDir, "tlh", "default-extensions.json"),
    '[\n  "legacy-profile"\n]\n',
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "scripts", "tlh-defaults.mjs"),
    'import "./lib/defaults-hop.mjs";\n',
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "scripts", "lib", "defaults-hop.mjs"),
    'import "./missing-defaults-lib.mjs";\n',
    "utf8",
  );
  writeFileSync(join(packageRoot, "config", "default-extensions.json"), "[]\n", "utf8");
  writeFileSync(
    join(packageRoot, "scripts", "tlh-tickets.mjs"),
    'import "./lib/tickets-hop.mjs";\n',
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "scripts", "lib", "tickets-hop.mjs"),
    'import "./missing-tickets-lib.mjs";\n',
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const wrapperEnv = scrubInstallerEnv({
    HOME: homeDir,
    PATH: process.env.PATH || "",
    TLH_DEFAULTS_LOG: defaultsLog,
    TLH_TICKETS_LOG: ticketsLog,
  });

  const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(defaultsResult.status, 1);
  assert.match(
    defaultsResult.stderr,
    /tlh defaults package support files are missing or corrupt; run `tlh update` to recover\./,
  );
  assert.doesNotMatch(defaultsResult.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(existsSync(defaultsLog), false);

  const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(ticketsResult.status, 1);
  assert.match(
    ticketsResult.stderr,
    /tlh tickets package support files are missing or corrupt; run `tlh update` to recover\./,
  );
  assert.doesNotMatch(ticketsResult.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(existsSync(ticketsLog), false);
});

test("wrapper falls back to the profile recovery updater when package update helper transitive imports are missing", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const legacyUpdateLog = join(root, "legacy-update.log");
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(packageRoot, "scripts", "lib"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(agentDir, "tlh", "install-state.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repo: "diegopetrucci/the-last-harness",
        track: "latest-release",
        packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
        packageSourceIsDefault: true,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageRoot, "scripts", "tlh-update.mjs"),
    'import "./lib/update-hop.mjs";\n',
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "scripts", "lib", "update-hop.mjs"),
    'import "./missing-update-hop.mjs";\n',
    "utf8",
  );
  copyFileSync(
    join(repoRoot, "scripts", "tlh-recover-update.mjs"),
    join(agentDir, "tlh", "recover-update.mjs"),
  );
  writeFileSync(
    join(agentDir, "tlh", "tlh-update.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(legacyUpdateLog)}, "legacy profile update should not run\\n");\nprocess.exit(91);\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["update", "--dry-run"], {
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: process.env.PATH || "",
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /The Last Harness update plan/);
  assert.match(result.stdout, /releases\/latest\/download\/install\.sh/);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(legacyUpdateLog), false);
});

test("wrapper uses the profile recovery updater before legacy profile update helpers", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const safeBin = join(root, "safe-bin");
  const fetchPreload = join(root, "stub-recovery-fetch.mjs");
  const bashLog = join(root, "bash.log");
  const legacyUpdateLog = join(root, "legacy-update.log");
  const bashPath =
    spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(safeBin, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(agentDir, "tlh", "install-state.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repo: "diegopetrucci/the-last-harness",
        track: "ref",
        ref: "main",
        packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
        packageSourceIsDefault: true,
      },
      null,
      2,
    ),
  );
  copyFileSync(
    join(repoRoot, "scripts", "tlh-recover-update.mjs"),
    join(agentDir, "tlh", "recover-update.mjs"),
  );
  writeFileSync(
    join(agentDir, "tlh", "tlh-update.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(legacyUpdateLog)}, "legacy profile update should not run\\n");\nprocess.exit(91);\n`,
    "utf8",
  );
  writeFileSync(
    join(safeBin, "bash"),
    [
      "#!/bin/sh",
      "marker=$(grep -F 'recovery stub marker' \"$1\" || true)",
      '{ printf \'cmd=%s\\n\' "$0"; printf \'argv=%s\\n\' "$*"; printf \'marker=%s\\n\' "${marker}"; printf \'repo=%s\\n\' "${TLH_REPO:-}"; printf \'source=%s\\n\' "${TLH_PACKAGE_SOURCE:-}"; printf \'agent=%s\\n\' "${PI_CODING_AGENT_DIR:-}"; printf \'path=%s\\n\' "${PATH:-}"; } >"${BASH_LOG}"',
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(safeBin, "bash"), 0o755);
  writeFileSync(
    fetchPreload,
    `globalThis.fetch = async () => ({\n\tok: true,\n\tstatus: 200,\n\tstatusText: "OK",\n\ttext: async () => "#!/usr/bin/env bash\\n# recovery stub marker\\nexit 0\\n",\n});\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(bashPath, [wrapper, "update", "--quiet"], {
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: `${safeBin}:${process.env.PATH || ""}`,
      NODE_OPTIONS: `--import=${fetchPreload}`,
      BASH_LOG: bashLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(existsSync(legacyUpdateLog), false);
  const bashRecord = Object.fromEntries(
    readFileSync(bashLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(bashRecord.cmd, join(safeBin, "bash"));
  assert.match(
    bashRecord.argv,
    new RegExp(`--agent-dir ${agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(
    bashRecord.argv,
    new RegExp(`--bin-dir ${binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(bashRecord.argv, /--wrapper-name tlh/);
  assert.match(bashRecord.argv, /--track ref/);
  assert.match(bashRecord.argv, /--ref main/);
  assert.match(bashRecord.argv, /--quiet/);
  assert.equal(bashRecord.marker, "# recovery stub marker");
  assert.equal(bashRecord.repo, "diegopetrucci/the-last-harness");
  assert.equal(bashRecord.source, "");
  assert.equal(bashRecord.agent, agentDir);
});

test("wrapper resolves pi to an absolute command path before exposing isolated bin", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const cwdDir = join(root, "cwd");
  const safeBinName = "safe-bin";
  const safeBin = join(cwdDir, safeBinName);
  const bashEnv = join(root, "bash-env.sh");
  const piLog = join(root, "pi.txt");
  const isolatedPiLog = join(root, "isolated-pi.log");
  const functionPiLog = join(root, "function-pi.log");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
  writeVersionedWrapperPi(safeBin, piLog);
  writeFileSync(
    bashEnv,
    "pi() {\n\tprintf 'shell function pi intercepted\\n' >\"${FUNCTION_PI_LOG}\"\n\treturn 79\n}\n",
    "utf8",
  );

  // Under the private-runtime model, --pi-cmd bakes the absolute pi path at wrapper-creation time.
  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(safeBin, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["chat"], {
    cwd: cwdDir,
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: [safeBinName, agentBin, process.env.PATH || ""].join(":"),
      BASH_ENV: bashEnv,
      PI_WRAPPER_LOG: piLog,
      ISOLATED_PI_LOG: isolatedPiLog,
      FUNCTION_PI_LOG: functionPiLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const piRecord = Object.fromEntries(
    readFileSync(piLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  // The absolute --pi-cmd path is exec'd directly; shell functions and PATH pi are bypassed.
  // piRecord.cmd is $0 from the exec'd script, which is the --pi-cmd value (not necessarily realpath'd).
  assert.ok(piRecord.cmd.endsWith("/pi"), `expected pi command to end with /pi: ${piRecord.cmd}`);
  assert.ok(isAbsolute(piRecord.cmd), `expected absolute pi path: ${piRecord.cmd}`);
  assert.equal(piRecord.argv, "chat");
  assert.equal(piRecord.agent, agentDir);
  const piPathEntries = piRecord.path.split(":");
  // PATH for pi: managed_bin (agentBin) first, then pinned_dir (safeBin, absolute), then sanitized PATH.
  assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, safeBin]);
  assert.equal(existsSync(isolatedPiLog), false);
  assert.equal(existsSync(functionPiLog), false);
});

test("wrapper falls back to the sanitized PATH when HOME is unset", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const supportedPiDir = join(root, "supported-pi");
  const piLog = join(root, "pi.txt");
  const isolatedPiLog = join(root, "isolated-pi.log");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
  writeVersionedWrapperPi(supportedPiDir, piLog);

  // In the private-runtime model, --pi-cmd is baked in at wrapper creation; HOME is not needed at runtime.
  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(supportedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const wrapperEnv = scrubInstallerEnv({
    PATH: [supportedPiDir, agentBin, process.env.PATH || ""].join(":"),
    PI_WRAPPER_LOG: piLog,
    ISOLATED_PI_LOG: isolatedPiLog,
  });
  delete wrapperEnv.HOME;
  const result = spawnSync(wrapper, ["chat"], {
    env: wrapperEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const piRecord = Object.fromEntries(
    readFileSync(piLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(piRecord.cmd, join(supportedPiDir, "pi"));
  assert.equal(piRecord.argv, "chat");
  assert.equal(piRecord.agent, agentDir);
  const piPathEntries = piRecord.path.split(":");
  assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, supportedPiDir]);
  assert.equal(existsSync(isolatedPiLog), false);
});

test("wrapper --pi-cmd validates the pinned binary before fast-path exec", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const pinnedPiDir = join(root, "pinned-pi");
  const piCallLog = join(root, "pi-calls.log");
  const piMainLog = join(root, "pi-main.txt");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakePi(
    pinnedPiDir,
    [
      `printf '%s\\n' "$*" >>"${piCallLog}"`,
      `{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${piMainLog}"`,
      "exit 0",
    ].join("\n"),
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["chat"], {
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: [agentBin, process.env.PATH || ""].join(":"),
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const mainRecord = Object.fromEntries(
    readFileSync(piMainLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(mainRecord.argv, "chat");
  assert.equal(mainRecord.agent, agentDir);

  const allCalls = readFileSync(piCallLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(allCalls, ["chat"]);
});

test("wrapper --pi-cmd hard-fails when the pinned path is non-executable", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const piLog = join(root, "pi.txt");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missingPiCmd = join(root, "nonexistent", "pi");
  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      missingPiCmd,
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["chat"], {
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: [agentBin, process.env.PATH || ""].join(":"),
      PI_WRAPPER_LOG: piLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Under the private-runtime model, a missing pinned binary is a hard error.
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /private pi runtime not found at/);
  assert.equal(existsSync(piLog), false);
});

test("wrapper --pi-cmd fast path exports PATH as managed_bin:pinned_dir:sanitized_path", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const pinnedPiDir = join(root, "pinned-pi");
  const stalePiDir = join(root, "stale-pi");
  const piLog = join(root, "pi.txt");
  const stalePiLog = join(root, "stale-pi.log");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Pinned pi logs PATH so we can verify ordering.
  writeFakePi(
    pinnedPiDir,
    [
      `{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${piLog}"`,
      "exit 0",
    ].join("\n"),
  );

  // Stale pi should not be called and should not appear before pinned_dir.
  writeFakePi(
    stalePiDir,
    [`printf 'stale pi intercepted\\n' >"${stalePiLog}"`, "exit 85"].join("\n"),
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["chat"], {
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: [stalePiDir, agentBin, process.env.PATH || ""].join(":"),
      STALE_PI_LOG: stalePiLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const piRecord = Object.fromEntries(
    readFileSync(piLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.equal(piRecord.argv, "chat");
  assert.equal(piRecord.agent, agentDir);

  // PATH must be: managed_bin : pinned_dir : sanitized_path (stale entries come after).
  const piPathEntries = piRecord.path.split(":");
  assert.equal(
    piPathEntries[0],
    agentBin,
    `expected managed_bin first; got ${piPathEntries.join(":")}`,
  );
  assert.equal(
    piPathEntries[1],
    pinnedPiDir,
    `expected pinned_dir second; got ${piPathEntries.join(":")}`,
  );
  const stalePiIndex = piPathEntries.indexOf(stalePiDir);
  assert.ok(
    stalePiIndex === -1 || stalePiIndex > 1,
    `stale entry must not appear before pinned_dir; PATH: ${piPathEntries.join(":")}`,
  );

  // Verify stale pi was not invoked.
  assert.equal(existsSync(stalePiLog), false);
});

test("wrapper update --extensions helper prepends executable --pi-cmd directory before the sanitized PATH", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const pinnedPiDir = join(root, "pinned-pi");
  const cwdDir = join(root, "cwd");
  const updateLog = join(root, "update.json");
  const nodeDir = dirname(process.execPath);
  const bashPath =
    spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
  const bashDir = dirname(bashPath);
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(pinnedPiDir, { recursive: true });
  writeFileSync(
    join(pinnedPiDir, "pi"),
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '${TLH_NON_PINNED_PI_VERSION}\\n'; exit 0; fi\nprintf 'unexpected args: %s\\n' "$*" >&2\nexit 1\n`,
    "utf8",
  );
  chmodSync(join(pinnedPiDir, "pi"), 0o755);
  writeFileSync(
    join(agentDir, "tlh", "recover-update.mjs"),
    `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst pi = spawnSync("pi", ["--version"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, pi: { status: pi.status, stdout: pi.stdout, stderr: pi.stderr, error: pi.error?.message } }));\nprocess.exit(pi.status ?? (pi.error ? 1 : 0));\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["update", "--extensions", "--dry-run"], {
    cwd: cwdDir,
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
      TLH_UPDATE_LOG: updateLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  assert.deepEqual(updateRecord.argv, [
    "--agent-dir",
    agentDir,
    "--bin-dir",
    binDir,
    "--wrapper-name",
    "tlh",
    "--extensions",
    "--dry-run",
  ]);
  assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(updateRecord.pi.status, 0, JSON.stringify(updateRecord));
  assert.match(updateRecord.pi.stdout, new RegExp(escapeRegExp(TLH_NON_PINNED_PI_VERSION)));

  const updatePathEntries = updateRecord.env.PATH.split(delimiter);
  assert.equal(
    updatePathEntries[0],
    pinnedPiDir,
    `expected pinned_dir first; got ${updatePathEntries.join(delimiter)}`,
  );
  assert.equal(
    updatePathEntries[1],
    nodeDir,
    `expected sanitized PATH to follow pinned_dir; got ${updatePathEntries.join(delimiter)}`,
  );
  assert.equal(updatePathEntries.includes(""), false);
  assert.equal(updatePathEntries.includes("."), false);
  assert.equal(updatePathEntries.includes(cwdDir), false);
  assert.equal(updatePathEntries.includes(agentBin), false);
});

test("wrapper update --extensions helper prepends the pinned private runtime dir to PATH", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const pinnedPiDir = join(root, "pinned-pi");
  const cwdDir = join(root, "cwd");
  const updateLog = join(root, "update.json");
  const pinnedPiCallLog = join(root, "pinned-pi-calls.log");
  const nodeDir = dirname(process.execPath);
  const bashPath =
    spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
  const bashDir = dirname(bashPath);
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Pinned pi at 0.84.4 — still prepended for --extensions.
  writeFakePi(
    pinnedPiDir,
    [
      `printf '%s\\n' "$*" >>"${pinnedPiCallLog}"`,
      `if [[ "\${1:-}" == "--version" ]]; then printf '0.84.4\\n'; exit 0; fi`,
      "exit 85",
    ].join("\n"),
  );
  writeFileSync(
    join(agentDir, "tlh", "recover-update.mjs"),
    `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst pi = spawnSync("pi", ["--version"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, pi: { status: pi.status, stdout: pi.stdout, stderr: pi.stderr, error: pi.error?.message } }));\nprocess.exit(pi.status ?? (pi.error ? 1 : 0));\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["update", "--extensions", "--dry-run"], {
    cwd: cwdDir,
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
      TLH_UPDATE_LOG: updateLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  // For --extensions, the wrapper prepends the private runtime dir regardless of version.
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  const updatePathEntries = updateRecord.env.PATH.split(delimiter);
  assert.equal(
    updatePathEntries[0],
    pinnedPiDir,
    `expected pinned pi dir first for --extensions; got ${updatePathEntries.join(delimiter)}`,
  );
  assert.equal(updatePathEntries.includes(""), false);
  assert.equal(updatePathEntries.includes("."), false);
  assert.equal(updatePathEntries.includes(cwdDir), false);
  assert.equal(updatePathEntries.includes(agentBin), false);
  // The update script invokes pi --version and finds the pinned runtime.
  assert.match(updateRecord.pi.stdout, new RegExp(escapeRegExp(TLH_PINNED_PI_VERSION)));
});

test("wrapper plain update helper does not prepend executable --pi-cmd directory", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const pinnedPiDir = join(root, "pinned-pi");
  const cwdDir = join(root, "cwd");
  const updateLog = join(root, "update.json");
  const nodeDir = dirname(process.execPath);
  const bashPath =
    spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
  const bashDir = dirname(bashPath);
  mkdirSync(join(agentDir, "tlh"), { recursive: true });
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(pinnedPiDir, { recursive: true });
  writeFileSync(
    join(pinnedPiDir, "pi"),
    "#!/bin/sh\nprintf 'unexpected args: %s\\n' \"$*\" >&2\nexit 1\n",
    "utf8",
  );
  chmodSync(join(pinnedPiDir, "pi"), 0o755);
  writeFileSync(
    join(agentDir, "tlh", "recover-update.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`,
    "utf8",
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["update", "--dry-run"], {
    cwd: cwdDir,
    env: scrubInstallerEnv({
      HOME: homeDir,
      PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
      TLH_UPDATE_LOG: updateLog,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
  assert.deepEqual(updateRecord.argv, [
    "--agent-dir",
    agentDir,
    "--bin-dir",
    binDir,
    "--wrapper-name",
    "tlh",
    "--dry-run",
  ]);
  assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);

  const updatePathEntries = updateRecord.env.PATH.split(delimiter);
  assert.equal(
    updatePathEntries[0],
    nodeDir,
    `expected sanitized PATH first; got ${updatePathEntries.join(delimiter)}`,
  );
  assert.equal(
    updatePathEntries.includes(pinnedPiDir),
    false,
    `did not expect pinned_dir in PATH: ${updatePathEntries.join(delimiter)}`,
  );
  assert.equal(updatePathEntries.includes(""), false);
  assert.equal(updatePathEntries.includes("."), false);
  assert.equal(updatePathEntries.includes(cwdDir), false);
  assert.equal(updatePathEntries.includes(agentBin), false);
});

// ── NODE_COMPILE_CACHE wrapper tests ────────────────────────────────────────

test("wrapper pi exec path exports NODE_COMPILE_CACHE pointing at the runtime prefix", (t) => {
  const root = makeTempDir("tlh-wrapper-node-compile-cache-");
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const agentBin = join(agentDir, "bin");
  const runtimeDir = join(root, "runtime");
  const pinnedPiDir = join(runtimeDir, "bin");
  const binDir = join(root, "bin");
  const packageRoot = join(root, "package");
  const piLog = join(root, "pi.txt");
  mkdirSync(agentBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Fake pi logs NODE_COMPILE_CACHE so we can assert its value.
  writeFakePi(
    pinnedPiDir,
    [`{ printf 'compile_cache=%s\\n' "\${NODE_COMPILE_CACHE:-}"; } >"${piLog}"`, "exit 0"].join(
      "\n",
    ),
  );

  runHelper(
    "scripts/tlh-wrapper.mjs",
    [
      "--agent-dir",
      agentDir,
      "--bin-dir",
      binDir,
      "--wrapper-name",
      "tlh",
      "--package-root",
      packageRoot,
      "--pi-cmd",
      join(pinnedPiDir, "pi"),
    ],
    { homeDir },
  );

  const wrapper = join(binDir, "tlh");
  const result = spawnSync(wrapper, ["chat"], {
    env: scrubInstallerEnv({ HOME: homeDir, PATH: process.env.PATH || "" }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const piRecord = Object.fromEntries(
    readFileSync(piLog, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  // NODE_COMPILE_CACHE must point to <runtime-prefix>/node-compile-cache.
  // runtimeDir = dirname(pinnedPiDir), which is dirname(dirname(piCmd)).
  assert.equal(
    piRecord.compile_cache,
    join(runtimeDir, "node-compile-cache"),
    `NODE_COMPILE_CACHE must be runtimeDir/node-compile-cache; got: ${piRecord.compile_cache}`,
  );
});

test("stage-1 wrapper summary emits done header, blank line, and backtick-wrapped wrapper name", (t) => {
  const root = makeTempDir("tlh-install-stage1-wrapper-summary-");
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
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakeTk(fakebin);
  writeLoggingPi(fakebin, piLog);
  writeLoggingPi(templateDir, piLog);
  writeFakeNpmInstaller(fakebin, {
    npmLog,
    templatePiPath: join(templateDir, "pi"),
    installedPiPath: join(dirname(agentDir), "runtime", "bin", "pi"),
  });

  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: `${fakebin}:${binDir}:${process.env.PATH || ""}`,
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });
  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--wrapper-name", "tlh", "--no-settings"],
    env,
  );
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const lines = result.stdout.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l === "Done. The Last Harness is ready. Start with:");
  assert.ok(headerIdx !== -1, `summary header not found in stdout:\n${result.stdout}`);
  // The line immediately after the header must be blank (blank-line separation).
  assert.equal(lines[headerIdx + 1], "", "expected blank line directly after summary header");
  // The command must appear as the backtick-wrapped wrapper name — not as 'Start with: <cmd>' on the same line.
  assert.equal(
    lines[headerIdx + 2],
    "`tlh`",
    `expected backtick-wrapped wrapper name on the line after the blank; got: ${JSON.stringify(lines[headerIdx + 2])}`,
  );
});

test("stage-1 wrapper summary PATH warning appears before summary block when binDir not on PATH", (t) => {
  const root = makeTempDir("tlh-install-stage1-wrapper-path-warning-");
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
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakeTk(fakebin);
  writeLoggingPi(fakebin, piLog);
  writeLoggingPi(templateDir, piLog);
  writeFakeNpmInstaller(fakebin, {
    npmLog,
    templatePiPath: join(templateDir, "pi"),
    installedPiPath: join(dirname(agentDir), "runtime", "bin", "pi"),
  });

  // binDir intentionally NOT on PATH so the PATH warning fires.
  const env = scrubInstallerEnv({
    HOME: homeDir,
    PATH: `${fakebin}:${process.env.PATH || ""}`,
    TLH_PACKAGE_SOURCE: packageDir,
    TLH_SKIP_GNOSIS_INSTALL: "1",
  });

  // Run the installer with stdout and stderr merged at the OS level (2>&1) so the
  // captured output reflects true emission order — a naive stdout+stderr concatenation
  // would pass even if the bug came back, defeating the point of this test.
  const installerPath = join(repoRoot, "scripts/tlh-install.mjs");
  const args = [
    "--agent-dir",
    agentDir,
    "--bin-dir",
    binDir,
    "--wrapper-name",
    "tlh",
    "--no-settings",
  ];
  const shellCmd = renderShellWords([process.execPath, installerPath, ...args]) + " 2>&1";
  const merged = spawnSync("/bin/sh", ["-c", shellCmd], { cwd: repoRoot, env, encoding: "utf8" });

  assert.equal(merged.status, 0, `installer failed:\n${merged.stdout}`);

  const lines = merged.stdout.split(/\r?\n/);

  // The PATH warning must appear somewhere in the merged output.
  const warnIdx = lines.findIndex((l) => l.includes("is not on PATH"));
  assert.ok(warnIdx !== -1, `PATH warning not found in merged output:\n${merged.stdout}`);

  // The summary header must appear.
  const headerIdx = lines.findIndex((l) => l === "Done. The Last Harness is ready. Start with:");
  assert.ok(headerIdx !== -1, `summary header not found in merged output:\n${merged.stdout}`);

  // Warning must come BEFORE the header — not inside the summary block.
  assert.ok(
    warnIdx < headerIdx,
    `PATH warning (line ${warnIdx}) must appear before the summary header (line ${headerIdx}) in merged output:\n${merged.stdout}`,
  );

  // The summary block must remain intact: header → blank → backtick command.
  assert.equal(lines[headerIdx + 1], "", "expected blank line directly after summary header");
  assert.equal(
    lines[headerIdx + 2],
    "`tlh`",
    `expected backtick-wrapped wrapper name on the line after the blank; got: ${JSON.stringify(lines[headerIdx + 2])}`,
  );

  // No warning between the header and the backtick command.
  const linesBetween = lines.slice(headerIdx + 1, headerIdx + 3);
  assert.ok(
    !linesBetween.some((l) => l.includes("is not on PATH")),
    `PATH warning must not appear between header and backtick command; lines between: ${JSON.stringify(linesBetween)}`,
  );
});
