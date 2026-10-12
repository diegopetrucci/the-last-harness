import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { captureConsole, readPiLog, readPiLogRecords } from "./install-stage1-test-helpers.mjs";
import {
  assertPiCommands,
  makeDefaultExtensionInstallConfig,
} from "./install-stage1-default-extensions-test-helpers.mjs";

import {
  installDefaultExtensions,
  preInstallNpmDefaultExtensions,
} from "../scripts/tlh-install.mjs";
import { mcpAdapterCutoverHeldForInstall } from "../scripts/lib/tlh-install-npm.mjs";

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

test("stage-1 holds the legacy MCP adapter across batch and fallback update paths", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: [legacySource, "npm:helper"] },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  installDefaultExtensions(config);

  const records = readPiLogRecords(piLog);
  assert.ok(records.length > 0);
  assert.deepEqual(
    records.map((record) => record.command),
    ["update npm:helper"],
  );
  assert.equal(
    records.some((record) => record.command.includes("pi-mcp-adapter")),
    false,
  );
  assertPiCommands(piLog, agentDir, ["update npm:helper"]);
  assert.equal(existsSync(join(agentDir, "settings-wide-update.done")), false);
});

test("stage-1 npm pre-install holds the legacy MCP adapter while installing other pins", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:@scope/helper@1.0.0" },
  ];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: [legacySource, "npm:@scope/helper@1.0.0"] },
    fakeNpmBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"',
  });

  preInstallNpmDefaultExtensions(config);

  const npmLog = readFileSync(join(agentDir, "npm.log"), "utf8");
  assert.match(npmLog, /@scope\/helper@1\.0\.0/);
  assert.doesNotMatch(npmLog, /pi-mcp-adapter/);
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

test(
  "stage-1 npm --prefix is the canonical realpath when agentDir has a symlinked ancestor",
  { skip: process.platform === "win32" },
  (t) => {
    const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
    // symlinkedAgentAncestor places agentDir under <root>/link/agent where link
    // is a symlink, giving a deterministic symlinked ancestor on both macOS and Linux.
    const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
      defaultExtensions: defaults,
      settings: { packages: defaults.map((d) => d.source) },
      symlinkedAgentAncestor: true,
      fakeNpmBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"',
    });

    preInstallNpmDefaultExtensions(config);

    const npmLog = readFileSync(join(agentDir, "npm.log"), "utf8").trim();
    const prefixMatch = npmLog.match(/--prefix (\S+)/);
    assert.ok(prefixMatch, "npm.log should contain --prefix arg");
    const recordedPrefix = prefixMatch[1];

    // The prefix must be a staging directory, not the final npm root
    assert.ok(
      recordedPrefix.includes(".tlh-npm-defaults-"),
      "npm --prefix should be the staging dir",
    );
    // The stage was promoted; compare the recorded prefix against the canonical
    // form (realpathSync(agentDir) + stage basename). The recorded prefix must
    // not start with the symlinked ancestor path (<root>/link).
    const stageBasename = recordedPrefix.split("/").at(-1);
    const canonicalAgentDir = realpathSync(agentDir);
    assert.equal(
      recordedPrefix,
      join(canonicalAgentDir, stageBasename),
      "npm --prefix should be the canonical realpath of the stage dir (no symlinked ancestor)",
    );
    assert.ok(
      !recordedPrefix.startsWith(dirname(agentDir) + "/"),
      "npm --prefix should not start with the symlinked ancestor path",
    );
    // The stage must have been promoted to <agentDir>/npm
    assert.ok(
      existsSync(join(agentDir, "npm", "package.json")),
      "stage should be promoted to <agentDir>/npm",
    );
  },
);

// Regression 1: filter opt-out (extensions: []) + unpinned legacy adapter
// The gate must fire hold independently of the load opt-out so that no
// settings-wide `pi update --extensions` runs and no MCP adapter is
// pre-installed.  Non-MCP defaults must still be updated individually.
test("stage-1 filter-opted-out legacy adapter holds across install batch and leaves settings bytes unchanged", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: [
        { source: legacySource, extensions: [] }, // filter opt-out: package present but no extensions loaded
        "npm:helper",
      ],
    },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  const settingsBefore = readFileSync(config.settingsPath, "utf8");
  installDefaultExtensions(config);
  const settingsAfter = readFileSync(config.settingsPath, "utf8");

  const records = readPiLogRecords(piLog);
  assert.ok(records.length > 0, "at least one pi command should run for the non-MCP default");
  assert.deepEqual(
    records.map((record) => record.command),
    ["update npm:helper"],
    "should update only the non-MCP default individually (no batch update --extensions)",
  );
  assert.equal(
    records.some((r) => r.command.includes("pi-mcp-adapter")),
    false,
    "no pi command should mention the MCP adapter",
  );
  assert.equal(existsSync(join(agentDir, "settings-wide-update.done")), false);
  assert.equal(settingsBefore, settingsAfter, "settings bytes must not change");
});

// Defense-in-depth: the configured source here is the pinned legacy spec
// (@2.36.0), which does NOT match the default extension's native source
// (@5.0.0). Even if the gate returned "fresh" (old opt-out-aware behavior
// before pma-upkb), sourceMatches would be false and the native adapter would
// never be pre-installed. The test is kept to confirm the gate still fires and
// that the non-MCP pinned default (@scope/helper) is not incorrectly blocked.
test("stage-1 npm pre-install defense-in-depth: filter-opted-out pinned legacy spec is independently blocked by spec mismatch", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:@scope/helper@1.0.0" },
  ];
  const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: [
        { source: legacySource, extensions: [] }, // filter opt-out
        "npm:@scope/helper@1.0.0",
      ],
    },
    fakeNpmBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"',
  });

  preInstallNpmDefaultExtensions(config);

  const npmLog = readFileSync(join(agentDir, "npm.log"), "utf8");
  assert.match(npmLog, /@scope\/helper@1\.0\.0/, "non-MCP pinned default must be pre-installed");
  assert.doesNotMatch(npmLog, /pi-mcp-adapter/, "held MCP adapter must not be pre-installed");
});

// Regression 2: marker opt-out (tlh.disabledDefaultExtensions) + legacy adapter
// Even when the adapter is marker-disabled, a legacy configured entry must still
// trigger hold so that `pi update --extensions` is not run.
test("stage-1 marker-opted-out legacy adapter holds across install batch and skips settings-wide update", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: [legacySource, "npm:helper"],
      tlh: { disabledDefaultExtensions: ["mcporter"] },
    },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  installDefaultExtensions(config);

  assertPiCommands(piLog, agentDir, ["update npm:helper"]);
  assert.equal(
    existsSync(join(agentDir, "settings-wide-update.done")),
    false,
    "settings-wide update sentinel must not appear",
  );
});

// Regression 3: control — opt-out with NO adapter package configured must still
// use the normal settings-wide refresh (gate returns fresh, not hold).
test("stage-1 adapter-absent opt-out still runs the settings-wide batch update", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  // No adapter entry in packages at all; only the marker disables it.
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: ["npm:helper"],
      tlh: { disabledDefaultExtensions: ["mcporter"] },
    },
    fakePiBody: 'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
  });

  installDefaultExtensions(config);

  assertPiCommands(piLog, agentDir, ["update --extensions"]);
});

// Regression 5 (reviewer scenario): filter opt-out + UNPINNED legacy adapter
// entry + a 2.x cached install.  The gate resolves the version from installed
// metadata under <agentDir>/npm/node_modules/<name>/package.json (the managed
// npm install path).  Holds must fire even though neither a declared version
// nor an explicit version selector is present in the source string.
test("stage-1 filter-opted-out unpinned adapter with 2.x installed metadata holds across install batch and leaves settings bytes unchanged", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const unpinnedSource = "npm:@diegopetrucci/pi-mcp-adapter"; // no version pin
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: {
      packages: [
        { source: unpinnedSource, extensions: [] }, // filter opt-out, no version pin
        "npm:helper",
      ],
    },
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  // Simulate a cached legacy install: write 2.x package.json at the path the
  // gate's installed-metadata lookup reads for npm sources:
  //   <agentDir>/npm/node_modules/<name>/package.json
  const npmPackageDir = join(agentDir, "npm", "node_modules", "@diegopetrucci", "pi-mcp-adapter");
  mkdirSync(npmPackageDir, { recursive: true });
  writeFileSync(
    join(npmPackageDir, "package.json"),
    JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "2.36.0" }, null, 2),
    "utf8",
  );

  const settingsBefore = readFileSync(config.settingsPath, "utf8");
  installDefaultExtensions(config);
  const settingsAfter = readFileSync(config.settingsPath, "utf8");

  const records = readPiLogRecords(piLog);
  assert.ok(records.length > 0, "at least one pi command should run for the non-MCP default");
  assert.deepEqual(
    records.map((record) => record.command),
    ["update npm:helper"],
    "should update only the non-MCP default individually \\\\ no settings-wide update --extensions",
  );
  assert.equal(
    records.some((r) => r.command.includes("pi-mcp-adapter")),
    false,
    "no pi command should mention the MCP adapter (held by installed 2.x metadata)",
  );
  assert.equal(settingsBefore, settingsAfter, "settings bytes must not change");
});

// ── pma-ymoo: project-layer gate tests ──────────────────────────────────────

// Test 1: Project-layer hold blocks the settings-wide refresh.
// The profile has only npm:helper (no adapter). The project layer at
// <agentDir>/.pi/settings.json has the unpinned legacy adapter identity and a
// cached 2.x install under <agentDir>/.pi/npm/node_modules/…/package.json.
// The gate must see the project layer hold and skip pi update --extensions,
// running only the individual npm:helper update.
test("stage-1 project-layer 2.x adapter hold blocks settings-wide refresh and updates only non-adapter defaults", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const unpinnedSource = "npm:@diegopetrucci/pi-mcp-adapter"; // no version pin
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: ["npm:helper"] }, // profile: only helper, no adapter
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  // Write the project settings file at <agentDir>/.pi/settings.json with the
  // unpinned adapter identity so the gate must resolve the version from metadata.
  const projectPiDir = join(agentDir, ".pi");
  mkdirSync(projectPiDir, { recursive: true });
  writeFileSync(
    join(projectPiDir, "settings.json"),
    JSON.stringify({ packages: [unpinnedSource] }, null, 2),
    "utf8",
  );

  // Write cached 2.x metadata at the path the gate resolves for agentDir=<agentDir>/.pi:
  //   <agentDir>/.pi/npm/node_modules/@diegopetrucci/pi-mcp-adapter/package.json
  const npmPackageDir = join(
    projectPiDir,
    "npm",
    "node_modules",
    "@diegopetrucci",
    "pi-mcp-adapter",
  );
  mkdirSync(npmPackageDir, { recursive: true });
  writeFileSync(
    join(npmPackageDir, "package.json"),
    JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "2.36.0" }, null, 2),
    "utf8",
  );

  const profileSettingsBefore = readFileSync(config.settingsPath, "utf8");
  const projectSettingsBefore = readFileSync(join(projectPiDir, "settings.json"), "utf8");
  installDefaultExtensions(config);
  const profileSettingsAfter = readFileSync(config.settingsPath, "utf8");
  const projectSettingsAfter = readFileSync(join(projectPiDir, "settings.json"), "utf8");

  const records = readPiLogRecords(piLog);
  assert.ok(records.length > 0, "at least one pi command should run for the non-MCP default");
  assert.deepEqual(
    records.map((r) => r.command),
    ["update npm:helper"],
    "should run only the non-adapter individual update (no settings-wide update --extensions)",
  );
  assert.equal(
    records.some((r) => r.command.includes("pi-mcp-adapter")),
    false,
    "no pi command should mention the MCP adapter (held by project-layer 2.x metadata)",
  );
  assert.equal(existsSync(join(agentDir, "settings-wide-update.done")), false);
  assert.equal(
    profileSettingsBefore,
    profileSettingsAfter,
    "profile settings bytes must not change",
  );
  assert.equal(
    projectSettingsBefore,
    projectSettingsAfter,
    "project settings bytes must not change",
  );
});

// Test 2: Project-layer fail-closed — malformed project settings means held.
// The profile has only npm:helper (no adapter). The project settings file
// exists but is invalid JSON. The gate must treat this as held and skip the
// settings-wide refresh, running only the individual npm:helper update.
test("stage-1 project-layer malformed settings is fail-closed and blocks settings-wide refresh", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];
  const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
    defaultExtensions: defaults,
    settings: { packages: ["npm:helper"] }, // profile: only helper, no adapter
    fakePiBody: [
      'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
      '[[ "$*" != *"pi-mcp-adapter"* ]] || { printf \'held MCP source was executed\\n\' >&2; exit 91; }',
    ].join("\n"),
  });

  // Write an invalid JSON file as the project settings.
  const projectPiDir = join(agentDir, ".pi");
  mkdirSync(projectPiDir, { recursive: true });
  writeFileSync(join(projectPiDir, "settings.json"), "not-valid-json", "utf8");

  installDefaultExtensions(config);

  // Malformed project settings → held → only individual updates, no batch refresh.
  const records = readPiLogRecords(piLog);
  assert.ok(records.length > 0, "at least one pi command should run for the non-MCP default");
  assert.deepEqual(
    records.map((r) => r.command),
    ["update npm:helper"],
    "should run only the non-adapter individual update (no settings-wide update --extensions)",
  );
  assert.equal(existsSync(join(agentDir, "settings-wide-update.done")), false);
});

// Test 3: Missing profile settings file no longer short-circuits to false.
// Before this fix, ENOENT on the profile layer immediately returned false
// (not held), bypassing the project layer entirely.  Now it is neutral for
// that layer and the project layer is still evaluated.
// Tested at the gate function level because with a missing profile settings
// file tlh-defaults returns empty settings ({}) → no sources enabled →
// installDefaultExtensions returns early, making any integration assertion
// about pi commands vacuous.
test("stage-1 gate: missing profile settings is neutral and project-layer hold is still evaluated", (t) => {
  const nativeSource = "npm:@diegopetrucci/pi-mcp-adapter@5.0.0";
  const legacySource = "npm:@diegopetrucci/pi-mcp-adapter@2.36.0";
  const unpinnedSource = "npm:@diegopetrucci/pi-mcp-adapter";
  const defaults = [
    { id: "mcporter", source: nativeSource, replaces: [legacySource] },
    { id: "helper", source: "npm:helper" },
  ];

  const root = mkdtempSync(join(tmpdir(), "tlh-gate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const agentDir = join(root, "agent");
  const defaultsPath = join(root, "default-extensions.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2), "utf8");

  // Set up the project layer with unpinned adapter + 2.x cached metadata.
  const projectPiDir = join(agentDir, ".pi");
  mkdirSync(projectPiDir, { recursive: true });
  const projectSettingsPath = join(projectPiDir, "settings.json");
  writeFileSync(
    projectSettingsPath,
    JSON.stringify({ packages: [unpinnedSource] }, null, 2),
    "utf8",
  );
  const npmPackageDir = join(
    projectPiDir,
    "npm",
    "node_modules",
    "@diegopetrucci",
    "pi-mcp-adapter",
  );
  mkdirSync(npmPackageDir, { recursive: true });
  writeFileSync(
    join(npmPackageDir, "package.json"),
    JSON.stringify({ name: "@diegopetrucci/pi-mcp-adapter", version: "2.36.0" }, null, 2),
    "utf8",
  );

  const config = {
    agentDir,
    homeDir: root,
    settingsPath: join(agentDir, "settings.json"), // does NOT exist
    supportFilePaths: { DEFAULT_EXTENSIONS_FILE: defaultsPath },
  };

  // Profile settings missing (ENOENT) + project holds → gate must return true (held).
  assert.equal(
    mcpAdapterCutoverHeldForInstall(config),
    true,
    "gate must be held when profile is missing but project layer holds",
  );

  // Sanity: both layers absent (remove project settings too) → not held.
  rmSync(projectSettingsPath);
  assert.equal(
    mcpAdapterCutoverHeldForInstall(config),
    false,
    "gate must not be held when both profile and project settings are absent",
  );
});

// Test 4 (control): No project settings file → normal settings-wide refresh.
// This is already proven by "stage-1 batches non-critical default extension
// updates" (the first test in this file), which writes a profile settings file
// with enabled defaults but no <agentDir>/.pi/settings.json, and asserts that
// pi update --extensions runs.  No new test is needed.
