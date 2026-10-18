import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  runInstaller,
  scrubInstallerEnv,
  TLH_PINNED_PI_VERSION,
  writeFakeCommand,
  writeFakeTk,
  writeLoggingPi,
} from "./install-stage1-core-test-helpers.mjs";
import { makeTempDir, readPiLog } from "./install-stage1-test-helpers.mjs";

const QUIET_TOOLS = JSON.parse(
  readFileSync(new URL("../config/default-extensions.json", import.meta.url), "utf8"),
)
  .find((entry) => entry.id === "quiet-tools")
  .source.replace(/^npm:/, "");

// Flow-level regression for the runInstallFlow ordering: the batched npm pre-install must run
// before installDefaultExtensions, because the first `pi install` creates the npm root and
// would make the batched pre-install skip.
test("stage-1 install flow batches pinned npm defaults before any per-package quiet-tools install", (t) => {
  const root = makeTempDir();
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const fakebin = join(root, "fakebin");
  const templateDir = join(root, "pi-template");
  const piLog = join(root, "pi.log");
  const npmLog = join(root, "npm.log");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(root, "package-source"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFakeTk(fakebin);
  writeLoggingPi(fakebin, piLog);
  writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
  // `npm ci` stages the pinned Pi runtime; `npm install <specs> --prefix <root>` materializes
  // each requested package manifest so the installer can see the pinned versions are present.
  writeFakeCommand(
    fakebin,
    "npm",
    [
      `printf '%s\\n' "$*" >>"${npmLog}"`,
      'if [[ "$1" == "ci" ]]; then',
      '  mkdir -p "node_modules/@earendil-works/pi-coding-agent/dist/bundle"',
      `  cp "${join(templateDir, "pi")}" "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"`,
      '  chmod +x "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"',
      'elif [[ "$1" == "install" ]]; then',
      "  shift",
      "  specs=()",
      "  prefix=",
      "  while [[ $# -gt 0 ]]; do",
      '    if [[ "$1" == "--prefix" ]]; then prefix="$2"; shift 2; continue; fi',
      '    if [[ "$1" != -* ]]; then specs+=("$1"); fi',
      "    shift",
      "  done",
      '  for spec in "${specs[@]}"; do',
      '    name="${spec%@*}"; version="${spec##*@}"',
      '    mkdir -p "$prefix/node_modules/$name"',
      '    printf \'{"name":"%s","version":"%s"}\' "$name" "$version" >"$prefix/node_modules/$name/package.json"',
      "  done",
      "fi",
    ].join("\n"),
  );

  const result = runInstaller(
    ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper"],
    scrubInstallerEnv({
      HOME: homeDir,
      PATH: `${fakebin}:${process.env.PATH || ""}`,
      TLH_PACKAGE_SOURCE: join(root, "package-source"),
      TLH_SKIP_GNOSIS_INSTALL: "1",
    }),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const batches = readFileSync(npmLog, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("install ") && line.includes("--prefix"));
  assert.equal(batches.length, 1, "exactly one batched npm install");
  const specs = batches[0].split(/\s+/).filter((arg) => /^@.+@\d/.test(arg));
  assert.ok(specs.includes(QUIET_TOOLS), "batch includes the pinned quiet-tools spec");
  assert.ok(
    specs.some((spec) => spec !== QUIET_TOOLS),
    "batch includes at least one other pinned npm default",
  );

  const perPackageQuietToolsInstalls = readPiLog(piLog).filter((line) =>
    /\|install npm:.*quiet-tools/.test(line),
  );
  assert.deepEqual(
    perPackageQuietToolsInstalls,
    [],
    "no per-package quiet-tools pi install after a successful batch",
  );
});
