import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { captureConsole, readPiLog } from "./install-stage1-test-helpers.mjs";
import {
  assertPiCommands,
  makeDefaultExtensionInstallConfig,
} from "./install-stage1-default-extensions-test-helpers.mjs";

import { installDefaultExtensions } from "../scripts/tlh-install.mjs";

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
