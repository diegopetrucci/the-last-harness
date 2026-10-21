import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NODE_RUNTIME_RANGE,
  NODE_RUNTIME_SHELL_CHECK,
  nodeRuntimeSupported,
} from "../scripts/lib/tlh-install-utils.mjs";
import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

const cases = [
  ["22.23.3", false],
  ["v22.23.4", true],
  ["22.24.0", true],
  ["23.99.0", false],
  ["24.21.99", false],
  ["24.22.0", false],
  ["24.22.1", true],
  ["24.23.0", true],
  ["25.99.0", false],
  ["26.11.99", false],
  ["26.12.0", false],
  ["26.12.1", true],
  ["26.13.0", true],
  ["27.0.0", false],
  ["20.99.0", false],
  ["26.12.1-rc.1", false],
  ["26.12.1junk", false],
  ["unknown", false],
];

test("package metadata and both shell preflights agree with the runtime security policy", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  assert.equal(manifest.engines.node, NODE_RUNTIME_RANGE);
  assert.equal(lock.packages[""].engines.node, NODE_RUNTIME_RANGE);
  const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  assert.ok(installer.includes(NODE_RUNTIME_SHELL_CHECK));
  for (const [version, expected] of cases) {
    assert.equal(nodeRuntimeSupported(version), expected, version);
    const result = spawnSync("bash", [
      "-c",
      `${NODE_RUNTIME_SHELL_CHECK}\ntlh_node_version_supported "$1"`,
      "policy",
      version,
    ]);
    assert.equal(result.status, expected ? 0 : 1, version);
  }
});

test("generated wrapper refuses vulnerable Node before executing Pi, including commands that skip the MCP guard", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-node-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrapper = join(root, "tlh");
  const node = join(root, "node");
  const pi = join(root, "pi");
  writeFileSync(pi, '#!/bin/bash\nprintf "pi launched\\n"\n', { mode: 0o755 });
  writeFileSync(
    wrapper,
    renderWrapper({
      agentDir: join(root, "agent"),
      binDir: join(root, "managed-bin"),
      wrapperName: "tlh",
      packageRoot: root,
      piCmd: pi,
    }),
    { mode: 0o755 },
  );
  for (const version of ["22.23.3", "24.22.0", "26.12.0", "26.12.1-rc.1", "unknown", "26.12.1"]) {
    writeFileSync(node, `#!/bin/bash\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    const result = spawnSync("/bin/bash", [wrapper, "list"], {
      cwd: "/",
      env: { ...process.env, PATH: `${root}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    assert.equal(result.status, version === "26.12.1" ? 0 : 1, result.stderr);
    if (version === "26.12.1") assert.match(result.stdout, /pi launched/);
    else {
      assert.match(result.stderr, /Node\.js .* is required/);
      assert.doesNotMatch(result.stdout, /pi launched/);
    }
  }
});

test("both managed dependency graphs pin patched npm Undici independently of Node", () => {
  for (const base of ["../", "../config/pi-runtime/"]) {
    const manifest = JSON.parse(readFileSync(new URL(`${base}package.json`, import.meta.url)));
    const lock = JSON.parse(readFileSync(new URL(`${base}package-lock.json`, import.meta.url)));
    assert.equal(manifest.overrides.undici, "8.12.2");
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith("/undici"));
    assert.ok(entries.length > 0, base);
    for (const [path, entry] of entries)
      assert.equal(entry.version, manifest.overrides.undici, path);
  }
});
