import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, "..");
const runnerPath = join(testsDir, "package-runtime-smoke-runner.mjs");

function isolatedEnv(root, agentDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "PI_CODING_AGENT_DIR" || key.startsWith("PI_SUBAGENT") || key.startsWith("TLH_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    TLH_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    TLH_SKIP_TELEMETRY: "1",
    TLH_SKIP_UPDATE_CHECK: "1",
  };
}

test("packed TLH generated JavaScript resolves from profile settings and reloads", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-package-runtime-smoke-"));
  const packDir = join(root, "pack");
  const extractDir = join(root, "extract");
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [packDir, extractDir, cwd, agentDir, homeDir])
    mkdirSync(path, { recursive: true });

  const env = isolatedEnv(root, agentDir);
  const packResult = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(packResult.status, 0, packResult.stderr || packResult.stdout);
  const [pack] = JSON.parse(packResult.stdout);
  const packedPaths = new Set(pack.files.map((file) => file.path));
  const generatedExtensionPaths = [
    ...globSync("extensions/**/*.ts", { cwd: repoRoot }).filter(
      (path) => !path.endsWith(".d.ts") && !path.startsWith("extensions/subagents/"),
    ),
    ...globSync("extensions/subagents/src/**/*.ts", { cwd: repoRoot }).filter(
      (path) => !path.endsWith(".d.ts"),
    ),
  ]
    .map((path) => path.replace(/\.ts$/, ".js"))
    .sort();
  assert.ok(
    generatedExtensionPaths.length > 0,
    "generated extension discovery must find at least one extension path",
  );
  for (const generatedPath of generatedExtensionPaths) {
    assert.ok(
      packedPaths.has(generatedPath),
      `npm pack omitted generated extension module ${generatedPath}`,
    );
  }
  const tarballPath = join(packDir, pack.filename);
  const extractResult = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
    env,
  });
  assert.equal(extractResult.status, 0, extractResult.stderr || extractResult.stdout);
  const packageRoot = realpathSync(join(extractDir, "package"));
  const smokeAgentsDir = join(packageRoot, "package-smoke-agents");
  mkdirSync(smokeAgentsDir, { recursive: true });
  writeFileSync(
    join(smokeAgentsDir, "worker.md"),
    `---
name: worker
description: deterministic packed package smoke worker
tools: read
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---
Return the deterministic faux child marker exactly.
`,
  );
  const packedManifestPath = join(packageRoot, "package.json");
  const packedManifest = JSON.parse(readFileSync(packedManifestPath, "utf8"));
  packedManifest["pi-subagents"] = { agents: ["./package-smoke-agents"] };
  writeFileSync(packedManifestPath, `${JSON.stringify(packedManifest, null, 2)}\n`);
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        packages: [packageRoot],
        tlh: {
          primaryAgent: { enabled: false, selected: "disabled" },
          telemetry: { enabled: false },
          updateCheck: { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
  );

  // npm pack intentionally excludes installed dependencies. Link the checkout's already-pinned,
  // offline node_modules into the disposable package so Pi can execute the packed artifact.
  symlinkSync(join(repoRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
  const runtimeResult = spawnSync(process.execPath, [runnerPath, packageRoot, cwd, agentDir], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  assert.equal(runtimeResult.status, 0, runtimeResult.stderr || runtimeResult.stdout);
  const runtimeEvidence = JSON.parse(runtimeResult.stdout.trim());
  assert.equal(runtimeEvidence.packageResolution.configuredPackage, packageRoot);
  assert.deepEqual(runtimeEvidence.packageResolution.resolvedPackageRoots, [packageRoot]);
  assert.equal(runtimeEvidence.packageResolution.scope, "user");
  assert.equal(runtimeEvidence.packageResolution.origin, "package");
  assert.deepEqual(runtimeEvidence.toolCounts, { subagent: 1 });
  assert.equal(runtimeEvidence.failedSubagentPatched, true);
  assert.equal(runtimeEvidence.childExecution.marker, "PACKED_FAUX_CHILD_MARKER");
  assert.equal(runtimeEvidence.childEnvRestored, true);
});
