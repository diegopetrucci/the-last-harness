import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertSupportedNodeRuntime, nodeVersionMeetsMinimum } from "../scripts/tlh-install.mjs";

const REQUIREMENT = "Node.js >=24.22.1 <25 or >=26.12.1";
const unsupported = (found) =>
  `${REQUIREMENT} is required (found ${found}). Install or upgrade Node.js, then rerun the installer.`;
const UNDETERMINED = `unable to determine Node.js version; The Last Harness requires ${REQUIREMENT}.`;

// Shared edge-case table: raw `node --version` output -> expected outcome.
// Both installers (stage-0 install.sh and stage-1 TypeScript) must agree on every row.
const ACCEPTED = ["v24.22.1", " v24.22.1 ", "v26.12.1\r\n", "27.0.0", "24.30.0"];
const UNSUPPORTED = [
  ["v24.22.0", "v24.22.0"],
  ["v25.9.0", "v25.9.0"],
  ["v26.12.0", "v26.12.0"],
  ["v22.23.4", "v22.23.4"],
  ["v26.12.1-nightly20261021", "v26.12.1-nightly20261021"],
  ["v27.0.0-pre", "v27.0.0-pre"],
  [" 27.0.0-rc.1\r\n", "v27.0.0-rc.1"],
];
const UNDETERMINED_INPUTS = ["", "garbage", "24.22.1junk", "24.22", "v24.22.1 junk", "vv24.22.1"];

test("stage-1 enforces the TLH Node runtime minimums", () => {
  for (const version of ["22.23.4", "24.22.0", "25.9.0", "26.12.0"]) {
    assert.equal(nodeVersionMeetsMinimum(version), false, version);
  }
  for (const version of ["24.22.1", "24.30.0", "26.12.1", "27.0.0"]) {
    assert.equal(nodeVersionMeetsMinimum(version), true, version);
  }
});

test("stage-1 applies the shared Node version edge-case table", () => {
  for (const raw of ACCEPTED) {
    assert.doesNotThrow(() => assertSupportedNodeRuntime(raw), JSON.stringify(raw));
  }
  for (const [raw, found] of UNSUPPORTED) {
    assert.throws(
      () => assertSupportedNodeRuntime(raw),
      { message: unsupported(found) },
      JSON.stringify(raw),
    );
  }
  for (const raw of UNDETERMINED_INPUTS) {
    assert.throws(
      () => assertSupportedNodeRuntime(raw),
      { message: UNDETERMINED },
      JSON.stringify(raw),
    );
  }
});

test("stage-0 install.sh preflight agrees with stage-1 on the shared table", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(path.join(tmpdir(), "tlh-stage0-node-"));
  try {
    // install.sh alone (no support root) so --dry-run stops after the preflight.
    copyFileSync(path.join(root, "install.sh"), path.join(dir, "install.sh"));
    const fakebin = path.join(dir, "fakebin");
    const home = path.join(dir, "home");
    spawnSync("mkdir", ["-p", fakebin, home]);
    writeFileSync(
      path.join(fakebin, "node"),
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then printf '%b' "\${FAKE_NODE_OUT-}"; exit 0; fi\nexit 99\n`,
    );
    chmodSync(path.join(fakebin, "node"), 0o755);

    const run = (raw) => {
      const result = spawnSync(
        "bash",
        [
          path.join(dir, "install.sh"),
          "--dry-run",
          "--agent-dir",
          path.join(dir, "agent"),
          "--bin-dir",
          path.join(dir, "bin"),
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            PATH: `${fakebin}:${process.env.PATH}`,
            HOME: home,
            TLH_SKIP_GNOSIS_INSTALL: "1",
            FAKE_NODE_OUT: raw.replaceAll("\r", "\\r").replaceAll("\n", "\\n"),
          },
        },
      );
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    for (const raw of ACCEPTED) {
      const { status, output } = run(raw);
      assert.equal(status, 0, `${JSON.stringify(raw)}: ${output}`);
      assert.doesNotMatch(output, /is required \(found|unable to determine Node/);
    }
    for (const [raw, found] of UNSUPPORTED) {
      const { status, output } = run(raw);
      assert.notEqual(status, 0, JSON.stringify(raw));
      assert.ok(output.includes(unsupported(found)), `${JSON.stringify(raw)}: ${output}`);
    }
    for (const raw of UNDETERMINED_INPUTS) {
      const { status, output } = run(raw);
      assert.notEqual(status, 0, JSON.stringify(raw));
      assert.ok(output.includes(UNDETERMINED), `${JSON.stringify(raw)}: ${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
