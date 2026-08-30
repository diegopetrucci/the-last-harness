import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
let originalPath: string | undefined;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Hostile ${name}\n---\n\nHostile package agent.\n`,
    "utf-8",
  );
}

function writePackage(packageRoot: string, agentName: string): void {
  writeJson(path.join(packageRoot, "package.json"), {
    "pi-subagents": { agents: ["agents"] },
  });
  writeAgent(path.join(packageRoot, "agents"), agentName);
}

describe("package agent source hard cutover", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-agent-home-"));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-agent-project-"));
    originalPath = process.env.PATH;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it("does not inject agents from project, user, global, or settings package roots", () => {
    const agentDir = path.join(tempHome, ".pi", "agent");
    const canonicalDir = path.join(agentDir, "tlh", "agents", "subagents");
    writeAgent(canonicalDir, "developer");

    // A project package at the repository root is a distinct source from the #588 snapshot seam.
    writeJson(path.join(tempProject, "package.json"), {
      "pi-subagents": { agents: ["agents"] },
    });
    writeAgent(path.join(tempProject, "agents"), "project-root-package-agent");

    // Installed project and user packages advertise agents through package metadata.
    writePackage(
      path.join(tempProject, ".pi", "npm", "node_modules", "project-package"),
      "project-installed-package-agent",
    );
    writePackage(
      path.join(agentDir, "npm", "node_modules", "user-package"),
      "user-installed-package-agent",
    );

    const globalRoot = path.join(tempHome, "global-node-modules");
    writePackage(path.join(globalRoot, "global-package"), "global-package-agent");
    const fakeNpmBin = path.join(tempHome, "bin");
    const npmInvocationMarker = path.join(tempHome, "npm-invoked");
    fs.mkdirSync(fakeNpmBin, { recursive: true });
    const fakeNpm = path.join(fakeNpmBin, process.platform === "win32" ? "npm.cmd" : "npm");
    const fakeNpmBody =
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${npmInvocationMarker}"\r\necho ${globalRoot}\r\n`
        : `#!/bin/sh\n: > '${npmInvocationMarker}'\nprintf '%s\\n' '${globalRoot}'\n`;
    fs.writeFileSync(fakeNpm, fakeNpmBody, "utf-8");
    if (process.platform !== "win32") fs.chmodSync(fakeNpm, 0o755);
    process.env.PATH = `${fakeNpmBin}${path.delimiter}${originalPath ?? ""}`;

    // Settings package sources must remain inert even when their package exists locally.
    const userSettingsPackage = path.join(tempHome, "settings-user-package");
    const projectSettingsPackage = path.join(tempProject, "settings-project-package");
    writePackage(userSettingsPackage, "user-settings-package-agent");
    writePackage(projectSettingsPackage, "project-settings-package-agent");
    writeJson(path.join(agentDir, "settings.json"), {
      packages: [{ source: `file:${userSettingsPackage}` }],
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      packages: [{ source: `file:${projectSettingsPackage}` }],
    });

    const discovered = discoverAgents(tempProject, "both");
    const all = discoverAgentsAll(tempProject);
    const hostileNames = [
      "project-root-package-agent",
      "project-installed-package-agent",
      "user-installed-package-agent",
      "global-package-agent",
      "user-settings-package-agent",
      "project-settings-package-agent",
    ];
    for (const name of hostileNames) {
      assert.equal(
        discovered.agents.some((agent) => agent.name === name),
        false,
        name,
      );
      assert.equal(
        all.package.some((agent) => agent.name === name),
        false,
        name,
      );
      assert.equal(
        all.user.some((agent) => agent.name === name),
        false,
        name,
      );
      assert.equal(
        all.project.some((agent) => agent.name === name),
        false,
        name,
      );
    }
    assert.equal(all.package.length, 0);
    assert.equal(fs.existsSync(npmInvocationMarker), false);
    assert.equal(discovered.agents.find((agent) => agent.name === "developer")?.source, "user");

    const listed = handleManagementAction("list", {}, { cwd: tempProject });
    const listText = listed.content
      .map((entry) => ("text" in entry && typeof entry.text === "string" ? entry.text : ""))
      .join("\n");
    for (const name of hostileNames) assert.equal(listText.includes(name), false, name);
    const fetched = handleManagementAction("get", { agent: hostileNames[0] }, { cwd: tempProject });
    assert.equal(fetched.isError, true);
  });
});
