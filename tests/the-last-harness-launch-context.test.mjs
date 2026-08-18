import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader, formatTlhLaunchContextAllocation } = await jiti.import(
  "../extensions/the-last-harness/header.ts",
);
const { estimateTlhLaunchContextAllocation } = await jiti.import(
  "../extensions/the-last-harness/launch-context.ts",
);
const { getMcpToolKind } = await jiti.import("../extensions/the-last-harness/mcp-tools.ts");

const plainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function estimateTokens(chars) {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createAllocation() {
  return {
    contextWindow: 10_000,
    estimatedTokens: {
      tlh: 0,
      agentsClaude: 1,
      skills: 99,
      tools: 100,
      mcp: 10,
      other: 155,
    },
  };
}

test("launch allocation attributes base runtime instructions to TLH and carves out prompt metadata", () => {
  const contextFile = {
    path: "/repo/AGENTS.md",
    content: "Repository <instructions> & conventions",
  };
  const skill = {
    name: "deploy&ship",
    description: "Use <deploy> safely",
    filePath: "/repo/.pi/skills/deploy&ship/SKILL.md",
  };
  const guideline = "Keep edits focused";
  const baseSystemPrompt = [
    "Pi startup overhead",
    contextFile.path,
    contextFile.content,
    escapeXml(skill.name),
    escapeXml(skill.description),
    escapeXml(skill.filePath),
    guideline,
    "Remaining prompt framing",
  ].join("\n");
  const tlhAddition = "\n\nTLH and active-primary instructions";
  const readTool = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: [guideline, guideline],
  };
  const inactiveTool = {
    name: "inactive",
    description: "This inactive definition must not be attributed",
    parameters: { type: "object", properties: { payload: { type: "string" } } },
  };
  const serializedTools = JSON.stringify([
    { name: readTool.name, description: readTool.description, parameters: readTool.parameters },
  ]);
  const agentsClaudeChars = contextFile.path.length + contextFile.content.length;
  const skillChars =
    escapeXml(skill.name).length +
    escapeXml(skill.description).length +
    escapeXml(skill.filePath).length;
  const baseInstructionChars =
    baseSystemPrompt.length - agentsClaudeChars - skillChars - guideline.length;

  const allocation = estimateTlhLaunchContextAllocation({
    contextWindow: 200_000,
    baseSystemPrompt,
    launchSystemPrompt: `${baseSystemPrompt}${tlhAddition}`,
    promptMetadata: { contextFiles: [contextFile], skills: [skill] },
    activeToolNames: ["read"],
    allTools: [readTool, inactiveTool],
  });

  assert.deepEqual(allocation, {
    contextWindow: 200_000,
    estimatedTokens: {
      tlh: estimateTokens(baseInstructionChars + tlhAddition.length),
      agentsClaude: estimateTokens(agentsClaudeChars),
      skills: estimateTokens(skillChars),
      tools: estimateTokens(guideline.length + serializedTools.length),
      mcp: 0,
      other: 0,
    },
  });
});

test("launch allocation requires a context window and excludes skill metadata without the read tool", () => {
  const options = {
    contextWindow: 100_000,
    baseSystemPrompt: "skill-name",
    launchSystemPrompt: "skill-name\n\nTLH",
    promptMetadata: {
      contextFiles: [],
      skills: [{ name: "skill-name", description: "description", filePath: "/skill/SKILL.md" }],
    },
    activeToolNames: [],
    allTools: [],
  };

  assert.equal(estimateTlhLaunchContextAllocation(options)?.estimatedTokens.skills, 0);
  assert.equal(
    estimateTlhLaunchContextAllocation({ ...options, contextWindow: undefined }),
    undefined,
  );
});

test("launch allocation formatting preserves category order and distinguishes zero and sub-one percent", () => {
  assert.equal(
    formatTlhLaunchContextAllocation(createAllocation()),
    "Context at launch: TLH 0% • AGENTS/CLAUDE.md <1% • Skills <1% • MCP <1% • Tools ~1% • Other ~2% (run /context to see a breakdown)",
  );
});

test("mcp segment is absent entirely when mcp bucket is zero", () => {
  const allocation = {
    contextWindow: 10_000,
    estimatedTokens: { tlh: 0, agentsClaude: 1, skills: 99, tools: 100, mcp: 0, other: 155 },
  };
  const result = formatTlhLaunchContextAllocation(allocation);
  assert.ok(!result.includes("MCP"), `Expected no MCP segment when mcp is 0, got: ${result}`);
});

test("tiny non-zero mcp bucket renders as 'MCP <1%' rather than being omitted", () => {
  const allocation = {
    contextWindow: 10_000,
    estimatedTokens: { tlh: 0, agentsClaude: 1, skills: 99, tools: 100, mcp: 1, other: 155 },
  };
  const result = formatTlhLaunchContextAllocation(allocation);
  assert.ok(result.includes("MCP <1%"), `Expected 'MCP <1%' for tiny non-zero mcp, got: ${result}`);
});

test("collapsed launch allocation hides resource names while expanded mode preserves the inventory", () => {
  const resources = {
    context: ["team-rules.md"],
    skills: ["deploy"],
    prompts: ["/review"],
    extensions: ["tools.js"],
    themes: ["night"],
  };
  const installNotice = { kind: "ref", summary: "non-stable ref", detail: "main" };
  const header = createTlhHeader(plainTheme, resources, undefined, installNotice, {
    launchContextAllocation: createAllocation(),
  });

  const collapsed = header.render(200);
  assert.ok(collapsed.includes(formatTlhLaunchContextAllocation(createAllocation())));
  assert.equal(
    collapsed.some((line) => line.includes("team-rules.md")),
    false,
  );
  assert.equal(
    collapsed.some((line) => line.includes("deploy")),
    false,
  );

  header.setExpanded(true);
  const expanded = header.render(200);
  const warningIndex = expanded.findIndex((line) => line.includes("running TLH from main track"));
  const allocationIndex = expanded.indexOf(formatTlhLaunchContextAllocation(createAllocation()));
  const contextIndex = expanded.indexOf("Context: team-rules.md");
  assert.equal(expanded.filter((line) => line.includes("running TLH from main track")).length, 1);
  assert.equal(allocationIndex, warningIndex + 1);
  assert.equal(contextIndex, allocationIndex + 1);
  for (const section of ["[Skills]", "[Prompts]", "[Extensions]", "[Themes]"]) {
    assert.ok(expanded.includes(section), `expected expanded inventory section ${section}`);
  }
});

// ── MCP bucket tests ──────────────────────────────────────────────────────────

test("mcp is 0 when no MCP tools are active", () => {
  const tool = {
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  };
  const allocation = estimateTlhLaunchContextAllocation({
    contextWindow: 100_000,
    baseSystemPrompt: "base",
    launchSystemPrompt: "base",
    promptMetadata: { contextFiles: [], skills: [] },
    activeToolNames: ["write"],
    allTools: [tool],
  });
  assert.equal(allocation?.estimatedTokens.mcp, 0);
});

test("mcp and tools buckets are disjoint and sum to the combined pre-split total", () => {
  // Build a prompt that contains both guideline strings so tracker.consume finds them.
  const nonMcpGuideline = "Non-MCP guideline text";
  const mcpGuideline = "MCP proxy guideline text";
  const baseSystemPrompt = `Base instructions\n${nonMcpGuideline}\n${mcpGuideline}\nMore content`;

  const normalTool = {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    promptGuidelines: [nonMcpGuideline],
  };
  const mcpTool = {
    name: "mcp",
    description: "MCP proxy tool",
    parameters: { type: "object", properties: { server: { type: "string" } } },
    promptGuidelines: [mcpGuideline],
  };

  // Sanity-check the fixture: mcpTool is classified as MCP, normalTool is not.
  assert.ok(getMcpToolKind(mcpTool.name, mcpTool) !== undefined, "mcpTool must be MCP");
  assert.ok(
    getMcpToolKind(normalTool.name, normalTool) === undefined,
    "normalTool must not be MCP",
  );

  const allocation = estimateTlhLaunchContextAllocation({
    contextWindow: 100_000,
    baseSystemPrompt,
    launchSystemPrompt: baseSystemPrompt,
    promptMetadata: { contextFiles: [], skills: [] },
    activeToolNames: ["bash", "mcp"],
    allTools: [normalTool, mcpTool],
  });

  const tokens = allocation?.estimatedTokens;
  assert.ok(tokens, "allocation must be defined");

  // Buckets must be disjoint: each tool's cost is in exactly one bucket.
  // tools chars = nonMcp guidelines + (combined definition − MCP-only definition).
  // This reflects the implementation's single combined serialization with subtraction
  // (avoids double-counting JSON array framing).
  const serializedMcp = JSON.stringify([
    { name: mcpTool.name, description: mcpTool.description, parameters: mcpTool.parameters },
  ]);
  const serializedAll = JSON.stringify([
    {
      name: normalTool.name,
      description: normalTool.description,
      parameters: normalTool.parameters,
    },
    { name: mcpTool.name, description: mcpTool.description, parameters: mcpTool.parameters },
  ]);
  const expectedToolsChars = nonMcpGuideline.length + serializedAll.length - serializedMcp.length;
  const expectedMcpChars = mcpGuideline.length + serializedMcp.length;

  assert.equal(tokens.tools, estimateTokens(expectedToolsChars), "tools bucket");
  assert.equal(tokens.mcp, estimateTokens(expectedMcpChars), "mcp bucket");

  // The pre-split total is the combined guideline chars plus the single combined
  // definition serialization. tools_chars + mcp_chars equals
  // totalGuidelineChars + toolDefinitionChars(allActiveTools) in character space.
  // Independent Math.ceil per partition means the token sum may differ by at most 1.
  const totalGuidelineChars = nonMcpGuideline.length + mcpGuideline.length;
  const preSplitTokens = estimateTokens(totalGuidelineChars + serializedAll.length);
  assert.ok(
    Math.abs(tokens.tools + tokens.mcp - preSplitTokens) <= 1,
    `mcp + tools token sum ${tokens.tools + tokens.mcp} should equal pre-split total ${preSplitTokens} within 1-token rounding tolerance`,
  );
});

test("tlh bucket is unchanged by the mcp/tools split", () => {
  const guideline = "Shared tool guideline";
  const baseSystemPrompt = `Runtime instructions\n${guideline}\nMore content`;
  const tlhAddition = "\n\nTLH additions";

  const normalTool = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: [guideline],
  };
  const mcpTool = {
    name: "mcp",
    description: "MCP proxy",
    parameters: { type: "object", properties: {} },
  };

  const options = {
    contextWindow: 100_000,
    baseSystemPrompt,
    launchSystemPrompt: `${baseSystemPrompt}${tlhAddition}`,
    promptMetadata: { contextFiles: [], skills: [] },
    activeToolNames: ["read", "mcp"],
    allTools: [normalTool, mcpTool],
  };

  // Expected tlh: base chars minus guideline (consumed by tools) plus tlhAddition.
  const expectedBaseInstructionChars = baseSystemPrompt.length - guideline.length;
  const expectedTlhTokens = estimateTokens(expectedBaseInstructionChars + tlhAddition.length);

  const allocation = estimateTlhLaunchContextAllocation(options);
  assert.equal(allocation?.estimatedTokens.tlh, expectedTlhTokens, "tlh bucket unchanged by split");
});

test("guideline shared between mcp and non-mcp tool is claimed exactly once", () => {
  // The same normalized guideline string appears on both an MCP tool and a non-MCP tool.
  // consumeToolGuidelinesPartitioned uses ONE shared seen set, so the guideline is consumed
  // from the prompt exactly once regardless of which partition processes it first.
  //
  // If the implementation were refactored to use two independent seen sets (one for MCP,
  // one for non-MCP), the guideline would be double-counted: guidelineChars.mcp and
  // guidelineChars.nonMcp would each include it, making embeddedToolChars too large,
  // which would shrink baseInstructionChars and produce a wrong tlh token count — and
  // would make tokens.tools + tokens.mcp overshoot the pre-split total by ~guideline chars.
  // Both assertions below would then fail, proving the test guards the invariant.
  const sharedGuideline = "This guideline appears on both an MCP and a non-MCP tool";
  const baseSystemPrompt = `Runtime instructions\n${sharedGuideline}\nMore content`;

  const normalTool = {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    promptGuidelines: [sharedGuideline],
  };
  const mcpTool = {
    name: "mcp",
    description: "MCP proxy tool",
    parameters: { type: "object", properties: { server: { type: "string" } } },
    promptGuidelines: [sharedGuideline],
  };

  // Sanity-check fixtures.
  assert.ok(getMcpToolKind(mcpTool.name, mcpTool) !== undefined, "mcpTool must be MCP");
  assert.ok(
    getMcpToolKind(normalTool.name, normalTool) === undefined,
    "normalTool must not be MCP",
  );

  const allocation = estimateTlhLaunchContextAllocation({
    contextWindow: 100_000,
    baseSystemPrompt,
    launchSystemPrompt: baseSystemPrompt,
    promptMetadata: { contextFiles: [], skills: [] },
    activeToolNames: ["bash", "mcp"],
    allTools: [normalTool, mcpTool],
  });

  const tokens = allocation?.estimatedTokens;
  assert.ok(tokens, "allocation must be defined");

  // Combined guideline attribution across both buckets must equal ONE guideline length,
  // not two. The combined tools + mcp token sum must match the pre-split formula
  // (single guideline + combined definition serialization) within <=1 token rounding.
  // Under the broken two-tracker refactor this sum would overshoot by ~sharedGuideline
  // chars / 4 tokens — well beyond the 1-token tolerance.
  const serializedAll = JSON.stringify([
    {
      name: normalTool.name,
      description: normalTool.description,
      parameters: normalTool.parameters,
    },
    { name: mcpTool.name, description: mcpTool.description, parameters: mcpTool.parameters },
  ]);
  const preSplitTokens = estimateTokens(sharedGuideline.length + serializedAll.length);
  assert.ok(
    Math.abs(tokens.tools + tokens.mcp - preSplitTokens) <= 1,
    `combined mcp+tools tokens (${tokens.tools + tokens.mcp}) should match one-guideline pre-split total (${preSplitTokens}) within 1-token rounding`,
  );

  // tlh must subtract the shared guideline exactly once — not twice.
  // Under the broken refactor, embeddedToolChars would be 2×guideline, making tlh too small.
  const expectedBaseInstructionChars = baseSystemPrompt.length - sharedGuideline.length;
  const expectedTlhTokens = estimateTokens(expectedBaseInstructionChars);
  assert.equal(tokens.tlh, expectedTlhTokens, "tlh subtracts the shared guideline exactly once");
});

test("collapsed launch allocation wraps within narrow terminal widths", () => {
  const header = createTlhHeader(
    plainTheme,
    { context: [], skills: [], prompts: [], extensions: [], themes: [] },
    undefined,
    undefined,
    { launchContextAllocation: createAllocation() },
  );
  const width = 28;
  const lines = header.render(width);

  assert.ok(lines.some((line) => line.startsWith("Context at launch:")));
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line exceeded width ${width}: ${JSON.stringify(line)}`);
  }
});
