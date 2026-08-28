import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

const repoRoot = realpathSync(join(import.meta.dirname, ".."));

function packRepository(destination) {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PI_OFFLINE: "1", TLH_SKIP_TELEMETRY: "1", TLH_SKIP_UPDATE_CHECK: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack?.filename, "npm pack must return a tarball filename");
  return join(destination, pack.filename);
}

test("staged package resolves trusted project agents without peer/dev node_modules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tlh-project-agent-package-resolution-"));
  const packDir = join(root, "pack");
  const extractDir = join(root, "extract");
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(join(projectRoot, ".tlh", "agents"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tarball = packRepository(packDir);
  const extractResult = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], {
    encoding: "utf8",
  });
  assert.equal(extractResult.status, 0, extractResult.stderr || extractResult.stdout);
  const packageRoot = realpathSync(join(extractDir, "package"));
  const stagedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const declaredRuntimeDependencies = Object.keys(stagedPackage.dependencies ?? {});
  assert.ok(
    declaredRuntimeDependencies.includes("typebox"),
    "runtime dependencies must remain staged",
  );
  for (const dependencyName of declaredRuntimeDependencies) {
    const dependencySource = join(repoRoot, "node_modules", ...dependencyName.split("/"));
    if (!existsSync(dependencySource)) continue;
    const dependencyTarget = join(packageRoot, "node_modules", ...dependencyName.split("/"));
    mkdirSync(join(dependencyTarget, ".."), { recursive: true });
    symlinkSync(dependencySource, dependencyTarget, "dir");
  }
  assert.equal(
    existsSync(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent")),
    false,
    "peer-only Pi package must not be installed under the staged package",
  );
  assert.equal(
    existsSync(join(packageRoot, "node_modules", "@earendil-works", "pi-tui")),
    false,
    "peer-only Pi TUI package must not be installed under the staged package",
  );
  assert.deepEqual(
    declaredRuntimeDependencies
      .filter((name) => existsSync(join(packageRoot, "node_modules", ...name.split("/"))))
      .sort(),
    [...declaredRuntimeDependencies].sort(),
    "staged package should expose its declared runtime dependency roots",
  );

  spawnSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  writeFileSync(
    join(projectRoot, ".tlh", "agents", "trusted.md"),
    `---
name: trusted
package: embedded
description: staged package resolution agent
tools: read
---
Loaded from the staged package.
`,
    "utf8",
  );

  const bridge = await import(
    pathToFileURL(
      join(packageRoot, "extensions", "the-last-harness", "project-agent-loader-bridge.mjs"),
    ).href
  );
  const access = await import(
    pathToFileURL(join(packageRoot, "extensions", "the-last-harness", "project-agent-access.mjs"))
      .href
  );
  const missingDependencies = await bridge.loadProjectAgentSnapshot({
    cwd: projectRoot,
    sessionId: "staged-package-missing-dependencies",
    agentDir,
    defaultProjectTrust: "always",
    context: { hasUI: false },
  });
  assert.equal(missingDependencies.status, "unavailable");

  const result = await bridge.loadProjectAgentSnapshot({
    cwd: projectRoot,
    sessionId: "staged-package-session",
    agentDir,
    defaultProjectTrust: "always",
    trustDependencies: {
      createProjectTrustStore: (trustAgentDir) => new ProjectTrustStore(trustAgentDir),
      hasTrustRequiringProjectResources,
    },
    context: { hasUI: false },
  });

  assert.equal(result.status, "loaded");
  assert.deepEqual(
    result.manifest?.entries.map((entry) => entry.agent.name),
    ["embedded.trusted"],
    "trusted project definitions must not become silently inert in the staged package",
  );
  const reauthorized = await bridge.reauthorizeTlhProjectAgentTrust(projectRoot, {
    agentDir,
    defaultProjectTrust: "always",
    trustDependencies: {
      createProjectTrustStore: (trustAgentDir) => new ProjectTrustStore(trustAgentDir),
      hasTrustRequiringProjectResources,
    },
    hasUI: false,
  });
  assert.equal(reauthorized.trusted, true);
  await access.retainTlhProjectAgentSnapshotReference(
    result.capability,
    "staged-package-runtime-reference",
  );
  await access.releaseTlhProjectAgentSnapshotReference("staged-package-runtime-reference");

  access.setTlhProjectAgentAccessProvider(() => ({ staged: true }));
  assert.deepEqual(access.getTlhProjectAgentAccess({}), { staged: true });
  access.setTlhProjectAgentAccessProvider(undefined);
});
