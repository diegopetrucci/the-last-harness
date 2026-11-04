import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseFrontmatter } from "../extensions/subagents/src/agents/frontmatter.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundledPrimaryRoot = join(repositoryRoot, "agents", "primary");
const bundledAgentsRoot = join(repositoryRoot, "agents", "subagents");

function listBundledMarkdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) return listBundledMarkdownFiles(filePath);
      return entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")
        ? [filePath]
        : [];
    })
    .sort();
}

function readAgentDefinitions(root) {
  return listBundledMarkdownFiles(root).map((filePath) => {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(content);
    return {
      filePath,
      relativePath: relative(root, filePath),
      name: frontmatter.name,
      tools: frontmatter.tools,
      body,
    };
  });
}

function readBundledDefinitions() {
  return readAgentDefinitions(bundledAgentsRoot);
}

function readPrimaryDefinitions() {
  return readAgentDefinitions(bundledPrimaryRoot);
}

function declaredTools(definition) {
  return String(definition.tools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

const PRIMARY_AGENT_NAMES = ["architect", "rush", "product", "bug-hunter"];
const MINOR_AGENT_NAMES = [
  "code-reviewer",
  "contrarian",
  "developer",
  "diff-summarizer",
  "librarian",
  "oracle",
  "repo-scout",
  "test-runner",
  "web-scout",
];

const EXPECTED_AGENT_TOOLS = {
  architect: [
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "bash",
    "subagent",
    "subagent_supervisor",
    "codemode",
  ],
  rush: [
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "bash",
    "subagent",
    "subagent_supervisor",
    "codemode",
  ],
  product: [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
    "subagent",
    "subagent_supervisor",
    "codemode",
  ],
  "bug-hunter": [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "subagent",
    "subagent_supervisor",
    "codemode",
  ],
  developer: [
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "ls",
    "bash",
    "contact_supervisor",
    "codemode",
  ],
  "code-reviewer": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "codemode"],
  contrarian: ["read", "grep", "find", "ls", "bash", "contact_supervisor", "codemode"],
  "diff-summarizer": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "codemode"],
  librarian: ["read", "grep", "find", "ls", "bash", "contact_supervisor", "codemode"],
  oracle: ["read", "grep", "find", "ls", "contact_supervisor", "bash", "codemode"],
  "repo-scout": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "codemode"],
  "test-runner": ["bash", "codemode"],
  "web-scout": [
    "web_search",
    "fetch_content",
    "get_search_content",
    "read",
    "grep",
    "find",
    "ls",
    "contact_supervisor",
    "codemode",
  ],
};

test("all packaged agents declare native codemode (no adapter mcp gateway) without dropping tools", () => {
  const primaryDefinitions = readPrimaryDefinitions();
  const minorDefinitions = readBundledDefinitions();
  const definitions = [...primaryDefinitions, ...minorDefinitions];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  assert.deepEqual(
    primaryDefinitions.map((definition) => definition.name).sort(),
    [...PRIMARY_AGENT_NAMES].sort(),
    "the packaged primary-agent inventory must cover all four roles",
  );
  assert.deepEqual(
    minorDefinitions.map((definition) => definition.name).sort(),
    [...MINOR_AGENT_NAMES].sort(),
    "the packaged minor-agent inventory must cover all nine roles",
  );
  assert.equal(
    definitions.length,
    13,
    "the packaged agent inventory must cover all thirteen roles",
  );

  for (const [name, expectedTools] of Object.entries(EXPECTED_AGENT_TOOLS)) {
    const definition = byName.get(name);
    assert.ok(definition, `${name} must be present in the packaged agent inventory`);
    assert.deepEqual(declaredTools(definition), expectedTools, `${name} must preserve its tools`);
    assert.ok(expectedTools.includes("codemode"), `${name} must declare codemode`);
    assert.equal(
      expectedTools.some((tool) => tool === "mcp" || tool.startsWith("mcp:")),
      false,
      `${name} must not declare the adapter gateway or direct MCP tools`,
    );
    const body = byName.get(name).body;
    assert.doesNotMatch(
      body,
      /mcp\(\{|generic `mcp`|adapter-shaped|`mcp:/,
      `${name}: no adapter prompts`,
    );
    assert.match(body, /tools\.mcp__<server>__<tool>/, `${name}: native MCP guidance`);
    assert.match(body, /isError/, `${name}: isError guidance`);
  }

  for (const name of [...PRIMARY_AGENT_NAMES, "developer"]) {
    assert.match(
      byName.get(name)?.body ?? "",
      /native MCP through `codemode`[\s\S]*authorized (?:task|ticket) scope/,
      `${name} must keep MCP use within its authorized scope`,
    );
  }

  for (const name of MINOR_AGENT_NAMES.filter(
    (minor) => !["developer", "test-runner"].includes(minor),
  )) {
    const body = byName.get(name)?.body ?? "";
    assert.match(body, /prompt restrictions, not enforcement/, `${name}: prompt-only MCP policy`);
    assert.match(body, /Avoid mutations/, `${name}: mutation restriction`);
    assert.match(
      body,
      /side effects are uncertain[\s\S]*escalate/,
      `${name}: uncertain effects escalation`,
    );
  }

  const testRunnerBody = byName.get("test-runner")?.body ?? "";
  assert.match(
    testRunnerBody,
    /including tools that change server-side state/,
    "test-runner must retain unrestricted codemode MCP access",
  );
  assert.match(
    testRunnerBody,
    /exact ordered (?:validation|shell\/MCP) steps/,
    "test-runner must retain exact assigned validation steps",
  );
});
