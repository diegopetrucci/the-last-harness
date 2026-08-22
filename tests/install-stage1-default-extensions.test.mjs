import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { captureConsole, readPiLog } from "./install-stage1-test-helpers.mjs";
import {
  assertPiCommands,
  makeDefaultExtensionInstallConfig,
} from "./install-stage1-default-extensions-test-helpers.mjs";

import {
  installDefaultExtensions,
  preInstallNpmDefaultExtensions,
} from "../scripts/tlh-install.mjs";

test("stage-1 batches non-critical default extension updates", (t) => {
  const defaults = [
    { id: "helper-a", source: "npm:helper-a" },
    { id: "helper-b", source: "npm:helper-b" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakePiBody: 'printf \'%s|%s|%s\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
  });

  installDefaultExtensions(config);

  assertPiCommands(piLog, agentDir, ["update --extensions"]);
});

test("stage-1 falls back to old-CLI positional per-source non-critical updates when batch update fails", (t) => {
  const criticalSource = "git:github.com/example/critical";
  const defaults = [
    { id: "critical", critical: true, source: criticalSource },
    { id: "helper-a", source: "npm:helper-a" },
    { id: "helper-b", source: "npm:helper-b" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      'if [[ "$1" == "update" && "${2:-}" == "--extensions" ]]; then',
      "\tprintf 'batch failed\\n' >&2",
      "\texit 42",
      "fi",
      'if [[ "$1" == "update" && "${2:-}" == "--extension" ]]; then',
      "\tprintf 'old pi does not support --extension\\n' >&2",
      "\texit 98",
      "fi",
      'if [[ "$1" == "update" && "${2:-}" == "npm:helper-a" ]]; then',
      '\ttouch "${PI_CODING_AGENT_DIR}/fallback-a.done"',
      "\texit 0",
      "fi",
      'if [[ "$1" == "update" && "${2:-}" == "npm:helper-b" ]]; then',
      '\ttouch "${PI_CODING_AGENT_DIR}/fallback-b.attempted"',
      "\tprintf 'helper-b failed\\n' >&2",
      "\texit 43",
      "fi",
      'if [[ "$1" == "install" && "${2:-}" == "git:github.com/example/critical" ]]; then',
      '\t[[ -f "${PI_CODING_AGENT_DIR}/fallback-a.done" && -f "${PI_CODING_AGENT_DIR}/fallback-b.attempted" ]] || { printf \'critical install ran before fallback completed\\n\' >&2; exit 44; }',
      "\texit 0",
      "fi",
    ].join("\n"),
  });

  const stderr = captureConsole("error", () => installDefaultExtensions(config));

  assertPiCommands(piLog, agentDir, [
    "update --extensions",
    "update npm:helper-a",
    "update npm:helper-b",
    "install git:github.com/example/critical",
  ]);
  assert.match(
    stderr,
    /warning: settings-wide extension refresh from merged settings failed; falling back to per-source updates for only 2 non-critical bundled default source\(s\)/,
  );
  assert.match(
    stderr,
    /warning: default extension package update failed; continuing: npm:helper-b/,
  );
  assert.match(stderr, /warning: 1 bundled default extension package\(s\) failed to update/);
});

test("stage-1 rejects unsafe critical default checkouts before settings-wide updates", (t) => {
  const criticalSource = "git:github.com/example/critical@pin";
  const defaults = [
    { id: "critical", critical: true, source: criticalSource },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      "printf 'pi should not run for unsafe critical checkout\\n' >&2",
      "exit 45",
    ].join("\n"),
  });
  mkdirSync(join(agentDir, "git", "github.com", "example", "critical"), { recursive: true });

  assert.throws(
    () => installDefaultExtensions(config),
    /refusing to use existing non-git critical default extension package checkout/,
  );
  assert.deepEqual(readPiLog(piLog), []);
});

test("stage-1 preflights critical checkouts before batch and validates critical refs after", (t) => {
  const criticalSource = "git:github.com/example/critical@pin";
  const defaults = [
    { id: "critical", critical: true, source: criticalSource },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      'if [[ "$1" == "update" && "${2:-}" == "--extensions" ]]; then',
      "\t[[ -f \"${PI_CODING_AGENT_DIR}/preflight-safe.done\" ]] || { printf 'settings-wide update ran before critical preflight\\n' >&2; exit 46; }",
      "\tprintf 'stage:settings-wide-batch\\n' >>\"${PI_LOG}.order\"",
      '\ttouch "${PI_CODING_AGENT_DIR}/settings-wide-update.done"',
      "\texit 0",
      "fi",
      'if [[ "$1" == "update" && "${2:-}" == "--extension" ]]; then',
      "\tprintf 'unexpected per-source fallback: %s\\n' \"$*\" >&2",
      "\texit 47",
      "fi",
      'if [[ "$1" == "install" && "${2:-}" == "git:github.com/example/critical@pin" ]]; then',
      "\t[[ -f \"${PI_CODING_AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'critical install ran before settings-wide update\\n' >&2; exit 48; }",
      "\t[[ -f \"${PI_CODING_AGENT_DIR}/critical-preinstall-validation.done\" ]] || { printf 'critical install ran before post-batch safety validation\\n' >&2; exit 49; }",
      "\tprintf 'stage:critical-install\\n' >>\"${PI_LOG}.order\"",
      '\ttouch "${PI_CODING_AGENT_DIR}/critical-install.done"',
      "\texit 0",
      "fi",
    ].join("\n"),
    fakeGitBody: [
      "target=''",
      'if [[ "${1:-}" == "-C" ]]; then target="$2"; shift 2; fi',
      'record_stage() { local stage="$1" marker="$2"; if [[ ! -f "${AGENT_DIR}/${marker}" ]]; then printf \'stage:%s\\n\' "$stage" >>"${PI_LOG}.order"; touch "${AGENT_DIR}/${marker}"; fi; }',
      'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--show-toplevel" ]]; then',
      '\tif [[ ! -f "${AGENT_DIR}/settings-wide-update.done" ]]; then',
      "\t\trecord_stage preflight-safe preflight-safe.done",
      '\telif [[ ! -f "${AGENT_DIR}/critical-install.done" ]]; then',
      "\t\t[[ -f \"${AGENT_DIR}/preflight-safe.done\" ]] || { printf 'post-batch validation ran before preflight\\n' >&2; exit 50; }",
      "\t\trecord_stage critical-preinstall-validation critical-preinstall-validation.done",
      "\telse",
      "\t\t[[ -f \"${AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'ref validation ran before settings-wide update\\n' >&2; exit 51; }",
      "\t\trecord_stage critical-ref-validation critical-ref-validation.done",
      "\tfi",
      "\tprintf '%s\\n' \"$target\"",
      "\texit 0",
      "fi",
      'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--absolute-git-dir" ]]; then printf \'%s/.git\\n\' "$target"; exit 0; fi',
      'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--git-common-dir" ]]; then printf \'%s/.git\\n\' "$target"; exit 0; fi',
      "exit 0",
    ].join("\n"),
  });
  mkdirSync(join(agentDir, "git", "github.com", "example", "critical", ".git"), {
    recursive: true,
  });

  installDefaultExtensions(config);

  assertPiCommands(piLog, agentDir, [
    "update --extensions",
    "install git:github.com/example/critical@pin",
  ]);
  const stages = readFileSync(`${piLog}.order`, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(stages, [
    "stage:preflight-safe",
    "stage:settings-wide-batch",
    "stage:critical-preinstall-validation",
    "stage:critical-install",
    "stage:critical-ref-validation",
  ]);
});

test("stage-1 keeps critical defaults on per-source install path while dry-run shows batch fallback", (t) => {
  const criticalSource = "git:github.com/example/critical@pin";
  const defaults = [
    { id: "critical", critical: true, source: criticalSource },
    { id: "helper", source: "npm:helper" },
  ];
  const { config } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    dryRun: true,
  });

  const stdout = captureConsole("log", () => installDefaultExtensions(config));

  assert.match(
    stdout,
    /Would preflight 1 critical bundled default git checkout target\(s\) before any settings-wide default extension update/,
  );
  assert.match(stdout, /pi install git:github\.com\/example\/critical@pin/);
  assert.match(
    stdout,
    /git -C .*\/git\/github\.com\/example\/critical fetch --prune --tags origin/,
  );
  assert.match(stdout, /Dry run: settings-wide extension refresh will run from merged settings/);
  assert.match(stdout, /PI_CODING_AGENT_DIR=.*pi update --extensions/);
  assert.match(stdout, /would retry only 1 non-critical bundled default source\(s\) individually/i);
  assert.doesNotMatch(stdout, /^Would.*\bpi\s+update\b/m);
  assert.doesNotMatch(stdout, /pi update --extension npm:helper/);
});

test("stage-1 batches only enabled pinned npm defaults from matching string and object settings", (t) => {
  const defaults = [
    { id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" },
    { id: "pkg-b", source: "npm:@scope/pkg-b@2.0.0" },
    { id: "pkg-c", source: "npm:@scope/pkg-c@3.0.0" },
    { id: "pkg-d", source: "npm:@scope/pkg-d@4.0.0" },
    { id: "unpinned", source: "npm:@scope/unpinned" },
    { id: "git", source: "git:github.com/example/git@pin" },
  ];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: [
        { source: "npm:@scope/pkg-a@1.0.0", extensions: ["index.js"] },
        "npm:@scope/pkg-b@2.0.0",
        "npm:@scope/unpinned",
        "npm:@scope/pkg-c@3.0.0",
        "npm:@scope/pkg-d@9.9.9",
        "npm:@scope/user-package@9.9.9",
      ],
      tlh: { disabledDefaultExtensions: ["pkg-c"] },
    },
    fakeNpmBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"',
    fakeCloudSyncBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/cloud-sync.log"',
  });

  preInstallNpmDefaultExtensions(config);

  const npmLog = readFileSync(join(agentDir, "npm.log"), "utf8").trim();
  assert.equal(npmLog.split(/\r?\n/).length, 1);
  assert.match(npmLog, /@scope\/pkg-a@1\.0\.0/);
  assert.match(npmLog, /@scope\/pkg-b@2\.0\.0/);
  assert.doesNotMatch(npmLog, /pkg-c|pkg-d|unpinned|user-package|git:/);
  assert.match(npmLog, /--prefix .*\.tlh-npm-defaults-/);
  assert.equal(npmLog.includes(`--prefix ${join(agentDir, "npm")}`), false);
  assert.ok(existsSync(join(agentDir, "npm", "package.json")));
  if (process.platform === "darwin" || process.platform === "linux") {
    assert.ok(
      existsSync(join(agentDir, "cloud-sync.log")),
      "cloud-sync ignore should be best effort invoked",
    );
  }
});

test("stage-1 hides the existing final npm root notice unless verbose", (t) => {
  const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  const npmRoot = join(agentDir, "npm");
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(join(npmRoot, "sentinel"), "preserve me");
  config.quiet = false;

  const normalStdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

  assert.doesNotMatch(
    normalStdout,
    /Skipping pinned npm default-extension pre-install because the npm root already exists/,
  );

  config.verbose = true;
  const verboseStdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

  assert.match(
    verboseStdout,
    /Skipping pinned npm default-extension pre-install because the npm root already exists \(left untouched\):/,
  );
  assert.equal(readFileSync(join(npmRoot, "sentinel"), "utf8"), "preserve me");
  assert.equal(existsSync(join(agentDir, "npm-called.log")), false);
  assert.deepEqual(
    readdirSync(agentDir).filter((entry) => entry.startsWith(".tlh-npm-defaults-")),
    [],
  );
});

test("stage-1 cleans staging and preserves a destination race after npm succeeds", (t) => {
  const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: [
      'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"',
      'mkdir -p "${AGENT_DIR}/npm"',
      "printf 'race\\n' >\"${AGENT_DIR}/npm/race-sentinel\"",
    ].join("\n"),
  });

  preInstallNpmDefaultExtensions(config);

  assert.equal(readFileSync(join(agentDir, "npm", "race-sentinel"), "utf8"), "race\n");
  assert.deepEqual(
    readdirSync(agentDir).filter((entry) => entry.startsWith(".tlh-npm-defaults-")),
    [],
  );
});

test(
  "stage-1 rejects a staging symlink and cleans only the staging entry",
  { skip: process.platform === "win32" },
  (t) => {
    const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
    const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
      defaultExtensions: defaults,
      settings: { packages: defaults.map((entry) => entry.source) },
      fakeNpmBody: [
        'stage_path=""',
        'while [[ "$#" -gt 0 ]]; do',
        '  if [[ "${1:-}" == "--prefix" ]]; then stage_path="${2:-}"; break; fi',
        "  shift",
        "done",
        '[[ -n "$stage_path" ]]',
        'rm -rf "$stage_path"',
        'ln -s "$NPM_EXTERNAL_TARGET" "$stage_path"',
      ].join("\n"),
    });
    const externalTarget = join(agentDir, "..", "external-stage-target");
    mkdirSync(externalTarget, { recursive: true });
    writeFileSync(join(externalTarget, "sentinel"), "keep me\n");
    config.env.NPM_EXTERNAL_TARGET = externalTarget;

    preInstallNpmDefaultExtensions(config);

    assert.equal(existsSync(join(agentDir, "npm")), false);
    assert.equal(readFileSync(join(externalTarget, "sentinel"), "utf8"), "keep me\n");
    assert.deepEqual(
      readdirSync(agentDir).filter((entry) => entry.startsWith(".tlh-npm-defaults-")),
      [],
    );
  },
);

test(
  "stage-1 preserves a raced final npm symlink and its external target",
  { skip: process.platform === "win32" },
  (t) => {
    const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
    const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
      defaultExtensions: defaults,
      settings: { packages: defaults.map((entry) => entry.source) },
      fakeNpmBody: [
        'mkdir -p "${AGENT_DIR}/external-npm"',
        "printf 'keep me\\n' >\"${AGENT_DIR}/external-npm/sentinel\"",
        'ln -s "${AGENT_DIR}/external-npm" "${AGENT_DIR}/npm"',
      ].join("\n"),
    });

    preInstallNpmDefaultExtensions(config);

    assert.equal(lstatSync(join(agentDir, "npm")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(agentDir, "external-npm", "sentinel"), "utf8"), "keep me\n");
    assert.deepEqual(
      readdirSync(agentDir).filter((entry) => entry.startsWith(".tlh-npm-defaults-")),
      [],
    );
  },
);

test("stage-1 cleans staging after npm failure and preserves a destination that appeared", (t) => {
  const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: [
      'mkdir -p "${AGENT_DIR}/npm"',
      "printf 'failure-race\\n' >\"${AGENT_DIR}/npm/race-sentinel\"",
      "exit 17",
    ].join("\n"),
  });

  preInstallNpmDefaultExtensions(config);

  assert.equal(readFileSync(join(agentDir, "npm", "race-sentinel"), "utf8"), "failure-race\n");
  assert.deepEqual(
    readdirSync(agentDir).filter((entry) => entry.startsWith(".tlh-npm-defaults-")),
    [],
  );
});

test("stage-1 treats an empty settings file as malformed and skips npm safely", (t) => {
  const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  config.quiet = false;
  writeFileSync(config.settingsPath, "");

  const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

  assert.match(stdout, /settings are unreadable or malformed/);
  assert.equal(existsSync(join(agentDir, "npm-called.log")), false);
});

test("stage-1 skips malformed settings, offline mode, and non-npm package managers safely", (t) => {
  const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
  const malformed = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  writeFileSync(malformed.config.settingsPath, "not-json");
  preInstallNpmDefaultExtensions(malformed.config);
  assert.equal(existsSync(join(malformed.agentDir, "npm-called.log")), false);

  const missing = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  rmSync(missing.config.settingsPath);
  preInstallNpmDefaultExtensions(missing.config);
  assert.equal(existsSync(join(missing.agentDir, "npm-called.log")), false);

  const offline = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: defaults.map((entry) => entry.source) },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  offline.config.env.PI_OFFLINE = "1";
  preInstallNpmDefaultExtensions(offline.config);
  assert.equal(existsSync(join(offline.agentDir, "npm-called.log")), false);

  const nonNpmManager = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: defaults.map((entry) => entry.source),
      npmCommand: ["pnpm"],
    },
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });
  preInstallNpmDefaultExtensions(nonNpmManager.config);
  assert.equal(existsSync(join(nonNpmManager.agentDir, "npm-called.log")), false);
});

test("stage-1 dry-run prints the staged npm command without creating roots", (t) => {
  const defaults = [
    { id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" },
    { id: "pkg-b", source: "npm:@scope/pkg-b@2.0.0" },
  ];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {},
    dryRun: true,
    fakeNpmBody: "printf 'called\\n' >>\"${AGENT_DIR}/npm-called.log\"",
  });

  const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

  assert.match(stdout, /npm install/);
  assert.match(stdout, /@scope\/pkg-a@1\.0\.0/);
  assert.match(stdout, /@scope\/pkg-b@2\.0\.0/);
  assert.match(stdout, /--prefix .*\.tlh-npm-defaults-<fresh>/);
  assert.match(stdout, /atomically promote/);
  assert.equal(existsSync(join(agentDir, "npm")), false);
  assert.equal(existsSync(join(agentDir, "npm-called.log")), false);
});
