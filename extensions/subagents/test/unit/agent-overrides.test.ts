import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

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

function writeCanonicalAgent(name: string, body: string): string {
  const filePath = path.join(tempHome, ".pi", "agent", "tlh", "agents", "subagents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

function findAgent(name: string, scope: "user" | "project" | "both" = "both") {
  const agent = discoverAgents(tempProject, scope).agents.find((entry) => entry.name === name);
  assert.ok(agent, `expected canonical ${name} agent`);
  return agent;
}

describe("canonical packaged agent overrides", () => {
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

  it("confirms no builtin agents are present in discoverAgentsAll", () => {
    assert.deepEqual(discoverAgentsAll(tempProject).builtin, []);
  });

  it("keeps arbitrary agentDirs settings inert while loading canonical roles", () => {
    const canonicalPath = writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nCanonical developer.\n",
    );
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: {
        agentDirs: [42, "vendor/agents"],
        agentOverrides: { developer: { model: "mock/canonical" } },
      },
    });

    const developer = findAgent("developer");
    assert.equal(developer.source, "user");
    assert.equal(developer.filePath, canonicalPath);
    assert.equal(developer.model, "mock/canonical");
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")), {
      subagents: {
        agentDirs: [42, "vendor/agents"],
        agentOverrides: { developer: { model: "mock/canonical" } },
      },
    });
  });

  it("prefers project subagents.defaultModel over user defaultModel for canonical roles", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { defaultModel: "deepseek-v4-flash" },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { defaultModel: "deepseek-v4-pro" },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );

    assert.equal(findAgent("code-reviewer").model, "deepseek-v4-pro");
  });

  it("applies subagents.defaultModel to canonical roles without a frontmatter model", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        defaultModel: "deepseek-v4-flash",
        agentOverrides: {
          developer: { model: "deepseek-v4-pro" },
        },
      },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\nmodel: google/gemini-3-pro\n---\n\nReview the code.\n",
    );
    writeCanonicalAgent(
      "repo-scout",
      "---\nname: repo-scout\ndescription: Scout code\n---\n\nScout the code.\n",
    );

    assert.equal(findAgent("developer").model, "deepseek-v4-pro");
    assert.equal(findAgent("code-reviewer").model, "google/gemini-3-pro");
    assert.equal(findAgent("repo-scout").model, "deepseek-v4-flash");
  });

  it("applies max execution time overrides to canonical roles", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          developer: { maxExecutionTimeMs: 1200 },
        },
      },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\nmaxExecutionTimeMs: 600\n---\n\nReview the code.\n",
    );
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          "code-reviewer": { maxExecutionTimeMs: 2400 },
        },
      },
    });

    assert.equal(findAgent("developer").maxExecutionTimeMs, 1200);
    assert.equal(findAgent("code-reviewer").maxExecutionTimeMs, 600);
  });

  it("surfaces malformed subagent default model settings", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, { subagents: { defaultModel: "" } });

    assert.throws(
      () => discoverAgents(tempProject, "both"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(settingsPath) &&
        error.message.includes("defaultModel"),
    );
  });

  it("prefers project settings overrides over user settings overrides for canonical roles", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai/gpt-5.4" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          "code-reviewer": { model: "openai-codex/gpt-5.4-mini", thinking: "high" },
        },
      },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );

    const reviewer = findAgent("code-reviewer");
    assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
    assert.equal(reviewer.thinking, "high");
    assert.equal(reviewer.override?.scope, "project");
    assert.equal(reviewer.override?.path, path.join(tempProject, ".pi", "settings.json"));
  });

  it("applies acceptance role precedence and false clearing to canonical roles", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          "code-reviewer": { acceptanceRole: "read-only" },
          developer: { acceptanceRole: "read-only" },
        },
      },
    });
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          "code-reviewer": { acceptanceRole: "writer" },
          developer: { acceptanceRole: false },
        },
      },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    assert.equal(findAgent("code-reviewer").acceptanceRole, "writer");
    assert.equal(findAgent("developer").acceptanceRole, undefined);
    assert.equal(findAgent("developer").override?.scope, "project");
  });

  it("does not apply project settings overrides when scope is user", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai/gpt-5.4" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai-codex/gpt-5.4-mini" } } },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );

    const reviewer = findAgent("code-reviewer", "user");
    assert.equal(reviewer.model, "openai/gpt-5.4");
    assert.equal(reviewer.override?.scope, "user");
  });

  it("does not apply user settings overrides when scope is project", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai/gpt-5.4" } } },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );

    const reviewer = findAgent("code-reviewer", "project");
    assert.notEqual(reviewer.model, "openai/gpt-5.4");
    assert.equal(reviewer.override, undefined);
  });

  it("does not read malformed out-of-scope settings files", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai-codex/gpt-5.4-mini" } } },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\n---\n\nReview the code.\n",
    );

    const reviewer = findAgent("code-reviewer", "project");
    assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
    assert.equal(reviewer.override?.scope, "project");
  });

  it("frontmatter wins per-field over agentOverrides for a canonical role", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai/gpt-5.4" } } },
    });
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Review code\nmodel: google/gemini-3-pro\n---\n\nReview the code.\n",
    );

    const reviewer = findAgent("code-reviewer");
    assert.equal(reviewer.source, "user");
    assert.equal(reviewer.model, "google/gemini-3-pro");
    assert.equal(reviewer.override, undefined);
  });

  it("fills in unset fields on a canonical role from project agentOverrides", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          developer: {
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
            supervisorBridge: false,
          },
        },
      },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.source, "user");
    assert.equal(developer.model, "anthropic/claude-sonnet-4-6");
    assert.deepEqual(developer.fallbackModels, ["openai/gpt-5-mini"]);
    assert.equal(developer.thinking, "high");
    assert.equal(developer.systemPromptMode, "append");
    assert.equal(developer.inheritProjectContext, true);
    assert.equal(developer.inheritSkills, true);
    assert.equal(developer.defaultContext, "fork");
    assert.equal(developer.acceptanceRole, "writer");
    assert.deepEqual(developer.tools, ["bash"]);
    assert.deepEqual(developer.skills, ["tdd"]);
    assert.deepEqual(developer.subagentOnlyExtensions, ["./tools/child-review.ts"]);
    assert.equal(developer.completionGuard, false);
    assert.equal(developer.supervisorBridge, false);
    assert.equal(developer.override?.scope, "project");
    assert.equal(developer.override?.path, path.join(tempProject, ".pi", "settings.json"));
  });

  it("fills in unset fields on a canonical role from user agentOverrides", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { developer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.source, "user");
    assert.equal(developer.model, "anthropic/claude-sonnet-4-6");
    assert.equal(developer.override?.scope, "user");
  });

  it("applies user agentOverrides to a canonical role", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { developer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.model, "anthropic/claude-sonnet-4-6");
    assert.equal(developer.override?.scope, "user");
  });

  it("prefers project agentOverrides over user agentOverrides on a canonical role", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { developer: { model: "anthropic/claude-sonnet-4-6" } } },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: { agentOverrides: { developer: { model: "openai/gpt-5.4" } } },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.model, "openai/gpt-5.4");
    assert.equal(developer.override?.scope, "project");
  });

  it("keeps explicit canonical frontmatter fields over matching agentOverrides", () => {
    fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        agentOverrides: {
          developer: {
            model: "anthropic/claude-sonnet-4-6",
            thinking: "high",
            tools: ["bash"],
            skills: ["override-skill"],
            inheritProjectContext: true,
            defaultContext: "fork",
            acceptanceRole: "writer",
            completionGuard: true,
            supervisorBridge: true,
          },
        },
      },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\nmodel: google/gemini-3-pro\nthinking: medium\ntools: read, mcp:local_tool\nskills: agent-skill\ninheritProjectContext: false\ndefaultContext: fresh\nacceptanceRole: read-only\ncompletionGuard: false\nsupervisorBridge: false\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.model, "google/gemini-3-pro");
    assert.equal(developer.thinking, "medium");
    assert.deepEqual(developer.tools, ["read"]);
    assert.deepEqual(developer.skills, ["agent-skill"]);
    assert.equal(developer.inheritProjectContext, false);
    assert.equal(developer.defaultContext, "fresh");
    assert.equal(developer.acceptanceRole, "read-only");
    assert.equal(developer.completionGuard, false);
    assert.equal(developer.supervisorBridge, false);
    assert.equal(developer.override, undefined);
  });

  it("leaves a canonical role untouched when no agentOverrides entry matches its name", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: { agentOverrides: { "code-reviewer": { model: "openai/gpt-5.4" } } },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: TLH developer\n---\n\nImplement the change.\n",
    );

    const developer = findAgent("developer");
    assert.equal(developer.model, undefined);
    assert.equal(developer.override, undefined);
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
      subagents: { agentOverrides: { reviewer: { inheritProjectContext: "true" } } },
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
      subagents: { agentOverrides: { reviewer: { acceptanceRole: "observer" } } },
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
          reviewer: { maxExecutionTimeMs: Number.MAX_SAFE_INTEGER + 1 },
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
      subagents: { agentOverrides: { reviewer: { completionGuard: "false" } } },
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
          developer: { model: "mock/omitted" },
          "code-reviewer": { tools: [] },
          "repo-scout": { tools: ["mcp:server/lookup"] },
          "diff-summarizer": { tools: ["read", "mcp:server/lookup"] },
          librarian: { tools: false },
          "web-scout": { model: "mock/base-null" },
        },
      },
    });
    writeCanonicalAgent(
      "developer",
      "---\nname: developer\ndescription: Omitted tools\n---\n\nOmitted tools.\n",
    );
    writeCanonicalAgent(
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: Empty tools\n---\n\nEmpty tools.\n",
    );
    writeCanonicalAgent(
      "repo-scout",
      "---\nname: repo-scout\ndescription: MCP-only tools\n---\n\nMCP-only tools.\n",
    );
    writeCanonicalAgent(
      "diff-summarizer",
      "---\nname: diff-summarizer\ndescription: Named tools\n---\n\nNamed tools.\n",
    );
    writeCanonicalAgent(
      "librarian",
      "---\nname: librarian\ndescription: Cleared tools override\n---\n\nTools inherit defaults.\n",
    );
    writeCanonicalAgent(
      "web-scout",
      "---\nname: web-scout\ndescription: Explicit empty frontmatter tools\ntools:\n---\n\nBase null tools.\n",
    );

    assert.equal(findAgent("developer").tools, undefined);
    assert.equal(findAgent("code-reviewer").tools, null);
    assert.equal(findAgent("repo-scout").tools, null);
    assert.deepEqual(findAgent("diff-summarizer").tools, ["read"]);
    assert.equal(findAgent("librarian").tools, undefined);

    const baseNull = findAgent("web-scout");
    assert.ok(baseNull.override);
    assert.equal(baseNull.override.base.tools, null);
  });

  it("rejects malformed override tool values with a boundary error", () => {
    const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
    writeJson(settingsPath, {
      subagents: { agentOverrides: { worker: { tools: null } } },
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
