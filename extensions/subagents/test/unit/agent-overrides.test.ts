import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents as upstreamDiscoverAgents,
  discoverAgentsAll as upstreamDiscoverAgentsAll,
} from "../../src/agents/agents.ts";
import { isCanonicalPackagedMinorAgent } from "../../../shared/project-agent-guidance.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function ensureProjectTrust(cwd: string): void {
  if (!fs.existsSync(path.join(cwd, ".git"))) execFileSync("git", ["init", "--quiet"], { cwd });
  const agentDir = path.join(tempHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  new ProjectTrustStore(agentDir).set(cwd, true);
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
  ensureProjectTrust(cwd);
  const filePath = path.join(cwd, ".tlh", "agents", "custom", `${name.toUpperCase()}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const customBody = body.replace(/^---\n/, "---\npackage: embedded\n");
  fs.writeFileSync(filePath, customBody, "utf-8");
}

function projectAgentView<
  T extends { agents: Array<{ projectCustomBinding?: unknown; localName?: string; name: string }> },
>(result: T): T {
  return {
    ...result,
    agents: result.agents.map((agent) =>
      agent.projectCustomBinding && agent.localName ? { ...agent, name: agent.localName } : agent,
    ),
  };
}

function discoverAgents(cwd: string, scope: "user" | "project" | "both") {
  return projectAgentView(upstreamDiscoverAgents(cwd, scope));
}

function discoverAgentsAll(cwd: string) {
  const result = upstreamDiscoverAgentsAll(cwd);
  return {
    ...result,
    project: result.project.map((agent) =>
      agent.projectCustomBinding && agent.localName ? { ...agent, name: agent.localName } : agent,
    ),
  };
}

function writeUserAgent(home: string, name: string, body: string): void {
  const filePath = path.join(home, ".pi", "agent", "agents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
  // Cutover boundary coverage: root custom-agent assertions intentionally seed legacy
  // profile/project settings and user-defined sources to prove they cannot override or
  // replace the exact trusted Git-root file. Those sources are not supported TLH custom
  // authorization paths, while canonical packaged minor roles still accept their own
  // settings overrides.
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    if (originalExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it("preserves canonical packaged provenance when settings override the copied prompt (legacy agentDirs is ignored)", () => {
    const agentDir = path.join(tempHome, ".pi", "agent");
    const canonicalPath = path.join(agentDir, "tlh", "agents", "subagents", "developer.md");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(
      canonicalPath,
      "---\nname: developer\ndescription: TLH developer\n---\n\nPackaged developer.\n",
      "utf-8",
    );
    writeJson(path.join(agentDir, "settings.json"), {
      subagents: {
        agentDirs: ["tlh/agents/subagents"],
        agentOverrides: { developer: { model: "mock/override" } },
      },
    });

    const developer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "developer",
    );
    assert.ok(developer);
    assert.equal(developer.filePath, canonicalPath);
    assert.equal(developer.model, "mock/override");
    assert.equal(developer.override?.scope, "user");
    assert.equal(isCanonicalPackagedMinorAgent(developer), true);
  });

  it("confirms no builtin agents are present in discoverAgentsAll", () => {
    assert.deepEqual(discoverAgentsAll(tempProject).builtin, []);
  });

  it("does not apply subagents.defaultModel to trusted root custom agents", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { defaultModel: "deepseek-v4-flash" },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { defaultModel: "deepseek-v4-pro" },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );

    const auditor = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.ok(auditor);
    assert.equal(auditor.model, undefined);
  });

  it("keeps root custom models absent when only settings provide defaults", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        defaultModel: "deepseek-v4-flash",
        agentOverrides: {
          implementer: { model: "deepseek-v4-pro" },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\nmodel: google/gemini-3-pro\n---\n\nAudit the code.\n`,
    );
    writeProjectAgent(
      tempProject,
      "scout-copy",
      `---\nname: scout-copy\ndescription: Scout code\n---\n\nScout the code.\n`,
    );

    const agents = discoverAgents(tempProject, "both").agents;
    assert.equal(agents.find((agent) => agent.name === "implementer")?.model, undefined);
    assert.equal(agents.find((agent) => agent.name === "auditor")?.model, "google/gemini-3-pro");
    assert.equal(agents.find((agent) => agent.name === "scout-copy")?.model, undefined);
  });

  it("does not apply max execution time overrides to root custom agents", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          implementer: { maxExecutionTimeMs: 1200 },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\nmaxExecutionTimeMs: 600\n---\n\nAudit the code.\n`,
    );
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          auditor: { maxExecutionTimeMs: 2400 },
        },
      },
    });

    const agents = discoverAgents(tempProject, "both").agents;
    assert.equal(
      agents.find((agent) => agent.name === "implementer")?.maxExecutionTimeMs,
      undefined,
    );
    assert.equal(agents.find((agent) => agent.name === "auditor")?.maxExecutionTimeMs, 600);
  });

  it("surfaces malformed subagent default model settings", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        defaultModel: "",
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("defaultModel"),
    );
  });

  it("ignores project and user settings overrides for root custom agents", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai/gpt-5.4" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: { auditor: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } },
      },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );

    const auditor = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.ok(auditor);
    assert.equal(auditor.model, undefined);
    assert.equal(auditor.thinking, undefined);
    assert.equal(auditor.override, undefined);
  });

  it("ignores acceptance-role settings overrides for root custom agents", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          auditor: { acceptanceRole: "read-only" },
          implementer: { acceptanceRole: "read-only" },
        },
      },
    });
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          auditor: { acceptanceRole: "writer" },
          implementer: { acceptanceRole: false },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const agents = discoverAgents(tempProject, "both").agents;
    assert.equal(agents.find((agent) => agent.name === "auditor")?.acceptanceRole, undefined);
    assert.equal(agents.find((agent) => agent.name === "implementer")?.acceptanceRole, undefined);
    assert.equal(agents.find((agent) => agent.name === "implementer")?.override, undefined);
  });

  it("does not expose root custom agents in user scope", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai/gpt-5.4" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai-codex/gpt-5.4-mini" } } },
    });
    writeUserAgent(
      tempHome,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );

    const auditor = discoverAgents(tempProject, "user").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.equal(auditor, undefined);
  });

  it("does not apply user settings overrides to root custom agents", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai/gpt-5.4" } } },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );

    const auditor = discoverAgents(tempProject, "project").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.ok(auditor);
    assert.notEqual(auditor.model, "openai/gpt-5.4");
    assert.equal(auditor.override, undefined);
  });

  it("does not apply project overrides while skipping malformed out-of-scope settings", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, ".pi", "agent", "settings.json"),
      '{"subagents":',
      "utf-8",
    );
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai-codex/gpt-5.4-mini" } } },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Audit code\n---\n\nAudit the code.\n`,
    );

    const auditor = discoverAgents(tempProject, "project").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.ok(auditor);
    assert.equal(auditor.model, undefined);
    assert.equal(auditor.override, undefined);
  });

  it("frontmatter wins per-field over agentOverrides for a project agent", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { auditor: { model: "openai/gpt-5.4" } } },
    });
    writeProjectAgent(
      tempProject,
      "auditor",
      `---\nname: auditor\ndescription: Project auditor\nmodel: google/gemini-3-pro\n---\n\nUse the project auditor.\n`,
    );

    const auditor = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "auditor",
    );
    assert.ok(auditor);
    assert.equal(auditor.source, "project");
    assert.equal(auditor.model, "google/gemini-3-pro");
    assert.equal(auditor.override, undefined);
  });

  it("keeps root custom configuration self-contained despite project agentOverrides", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          implementer: {
            model: "anthropic/claude-sonnet-4-6",
            fallbackModels: ["openai/gpt-5-mini"],
            thinking: "high",
            systemPromptMode: "append",
            inheritProjectContext: true,
            inheritSkills: true,
            defaultContext: "fork",
            acceptanceRole: "writer",
            tools: ["bash", "mcp:xcodebuild_list_sims"],
            skills: ["tdd"],
            subagentOnlyExtensions: ["./tools/child-review.ts"],
            completionGuard: false,
          },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.ok(implementer);
    assert.equal(implementer.source, "project");
    assert.equal(implementer.model, undefined);
    assert.equal(implementer.fallbackModels, undefined);
    assert.equal(implementer.thinking, undefined);
    assert.equal(implementer.systemPromptMode, "replace");
    assert.equal(implementer.inheritProjectContext, false);
    assert.equal(implementer.inheritSkills, false);
    assert.equal(implementer.defaultContext, undefined);
    assert.equal(implementer.acceptanceRole, undefined);
    assert.equal(implementer.tools, undefined);
    assert.equal(implementer.skills, undefined);
    assert.equal(implementer.subagentOnlyExtensions, undefined);
    assert.equal(implementer.completionGuard, undefined);
    assert.equal(implementer.override, undefined);
  });

  it("ignores generic user agents even when user agentOverrides names them", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeUserAgent(
      tempHome,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.equal(implementer, undefined);
  });

  it("does not apply user agentOverrides to a root custom project agent", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.ok(implementer);
    assert.equal(implementer.source, "project");
    assert.equal(implementer.model, undefined);
    assert.equal(implementer.override, undefined);
  });

  it("does not apply either settings override to a root custom project agent", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { implementer: { model: "openai/gpt-5.4" } } },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.ok(implementer);
    assert.equal(implementer.model, undefined);
    assert.equal(implementer.override, undefined);
  });

  it("keeps explicit custom frontmatter fields over matching agentOverrides", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          implementer: {
            model: "anthropic/claude-sonnet-4-6",
            thinking: "high",
            tools: ["bash"],
            skills: ["override-skill"],
            inheritProjectContext: true,
            defaultContext: "fork",
            acceptanceRole: "writer",
            completionGuard: true,
          },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\nmodel: google/gemini-3-pro\nthinking: medium\ntools: read, mcp:local_tool\nskills: agent-skill\ninheritProjectContext: false\ndefaultContext: fresh\nacceptanceRole: read-only\ncompletionGuard: false\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.ok(implementer);
    assert.equal(implementer.model, "google/gemini-3-pro");
    assert.equal(implementer.thinking, "medium");
    assert.deepEqual(implementer.tools, ["read"]);
    assert.deepEqual(implementer.skills, ["agent-skill"]);
    assert.equal(implementer.inheritProjectContext, false);
    assert.equal(implementer.defaultContext, "fresh");
    assert.equal(implementer.acceptanceRole, "read-only");
    assert.equal(implementer.completionGuard, false);
    assert.equal(implementer.override, undefined);
  });

  it("leaves a custom agent untouched when no agentOverrides entry matches its name", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
    });
    writeProjectAgent(
      tempProject,
      "implementer",
      `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`,
    );

    const implementer = discoverAgents(tempProject, "both").agents.find(
      (agent) => agent.name === "implementer",
    );
    assert.ok(implementer);
    assert.equal(implementer.model, undefined);
    assert.equal(implementer.override, undefined);
  });

  it("surfaces malformed settings files instead of silently ignoring them", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("Failed to parse settings file"),
    );
  });

  it("surfaces settings read failures without mislabeling them as parse errors", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    fs.mkdirSync(settingsPath, { recursive: true });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("Failed to read settings file"),
    );
  });

  it("surfaces malformed builtin override entries instead of silently ignoring them", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: {
            inheritProjectContext: "true",
          },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("inheritProjectContext"),
    );
  });

  it("surfaces malformed acceptance role override values", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: {
            acceptanceRole: "observer",
          },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("acceptanceRole"),
    );
  });

  it("surfaces malformed max execution time override values", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: {
            maxExecutionTimeMs: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("maxExecutionTimeMs"),
    );
  });

  it("surfaces malformed completion guard override values", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          reviewer: {
            completionGuard: "false",
          },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("reviewer") &&
        error.message.includes("completionGuard"),
    );
  });

  it("preserves omitted, explicit-empty, MCP-only, and named tool policies in overrides", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          omitted: { model: "mock/omitted" },
          empty: { tools: [] },
          "mcp-only": { tools: ["mcp:server/lookup"] },
          named: { tools: ["read", "mcp:server/lookup"] },
          cleared: { tools: false },
          "base-null": { model: "mock/base-null" },
        },
      },
    });
    writeProjectAgent(
      tempProject,
      "omitted",
      `---
name: omitted
description: Omitted tools
---

Omitted tools.
`,
    );
    writeProjectAgent(
      tempProject,
      "empty",
      `---
name: empty
description: Empty tools
---

Empty tools.
`,
    );
    writeProjectAgent(
      tempProject,
      "mcp-only",
      `---
name: mcp-only
description: MCP-only tools
---

MCP-only tools.
`,
    );
    writeProjectAgent(
      tempProject,
      "named",
      `---
name: named
description: Named tools
---

Named tools.
`,
    );
    writeProjectAgent(
      tempProject,
      "cleared",
      `---
name: cleared
description: Cleared tools override
---

Tools should inherit defaults.
`,
    );
    writeProjectAgent(
      tempProject,
      "base-null",
      `---
name: base-null
description: Explicit empty frontmatter tools
tools:
---

Base null tools.
`,
    );

    const agents = discoverAgents(tempProject, "both").agents;
    assert.equal(agents.find((agent) => agent.name === "omitted")?.tools, undefined);
    assert.equal(agents.find((agent) => agent.name === "empty")?.tools, undefined);
    assert.equal(agents.find((agent) => agent.name === "mcp-only")?.tools, undefined);
    assert.equal(agents.find((agent) => agent.name === "named")?.tools, undefined);
    assert.equal(agents.find((agent) => agent.name === "cleared")?.tools, undefined);

    const baseNull = agents.find((agent) => agent.name === "base-null");
    assert.equal(baseNull?.tools, null);
    assert.equal(baseNull?.override, undefined);
  });

  it("rejects malformed override tool values with a boundary error", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentOverrides: {
          worker: { tools: null },
        },
      },
    });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("worker") &&
        error.message.includes("tools") &&
        error.message.includes("array of strings or false"),
    );
  });
});
