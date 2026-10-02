import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { discoverAgents } from "../extensions/subagents/src/agents/agents.js";
import { parseFrontmatter } from "../extensions/subagents/src/agents/frontmatter.js";
import { withEnv } from "./test-fixture-helpers.mjs";

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
      acceptanceRole: frontmatter.acceptanceRole,
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
    "mcp",
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
    "mcp",
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
    "mcp",
  ],
  "bug-hunter": ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor", "mcp"],
  developer: ["read", "write", "edit", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  "code-reviewer": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  contrarian: ["read", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  "diff-summarizer": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  librarian: ["read", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  oracle: ["read", "grep", "find", "ls", "contact_supervisor", "bash", "mcp"],
  "repo-scout": ["read", "grep", "find", "ls", "bash", "contact_supervisor", "mcp"],
  "test-runner": ["bash", "mcp"],
  "web-scout": [
    "web_search",
    "fetch_content",
    "get_search_content",
    "read",
    "grep",
    "find",
    "ls",
    "contact_supervisor",
    "mcp",
  ],
};

function createBundledFixture(t, definitions) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-bundled-acceptance-roles-"));
  const home = join(fixtureRoot, "home");
  const agentDir = join(fixtureRoot, "agent");
  const workspace = join(fixtureRoot, "workspace");
  const canonicalAgentsDir = join(agentDir, "tlh", "agents", "subagents");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(canonicalAgentsDir, { recursive: true });
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const definition of definitions) {
    const target = join(canonicalAgentsDir, definition.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(definition.filePath, target);
  }

  return { home, agentDir, workspace };
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function assertAcceptanceRoles(discovered, definitions, overrides, scope, metadataScopes = {}) {
  const discoveredByName = new Map(discovered.agents.map((agent) => [agent.name, agent]));
  for (const definition of definitions) {
    const configured = overrides[definition.name];
    const expected =
      configured === false
        ? undefined
        : configured === undefined
          ? definition.acceptanceRole
          : configured;
    assert.equal(
      discoveredByName.get(definition.name)?.acceptanceRole,
      expected,
      `${definition.name} must resolve its ${scope} acceptanceRole setting`,
    );
    if (configured !== undefined) {
      const expectedScope = metadataScopes[definition.name] ?? scope;
      assert.equal(
        discoveredByName.get(definition.name)?.override?.scope,
        expectedScope,
        `${definition.name} must retain ${expectedScope} override metadata`,
      );
    }
  }
}

test("all packaged agents declare the generic MCP gateway without dropping tools", () => {
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
    assert.ok(expectedTools.includes("mcp"), `${name} must declare the generic MCP gateway`);
    assert.equal(
      expectedTools.some((tool) => tool.startsWith("mcp:")),
      false,
      `${name} must not declare direct MCP tools`,
    );
  }

  for (const name of [...PRIMARY_AGENT_NAMES, "developer"]) {
    assert.match(
      byName.get(name)?.body ?? "",
      /generic `mcp` gateway[\s\S]*authorized (?:task|ticket) scope/,
      `${name} must keep MCP use within its authorized scope`,
    );
  }

  for (const name of MINOR_AGENT_NAMES.filter(
    (minor) => !["developer", "test-runner"].includes(minor),
  )) {
    const body = byName.get(name)?.body ?? "";
    assert.match(
      body,
      /prompt restrictions, not gateway enforcement/,
      `${name}: prompt-only MCP policy`,
    );
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
    "test-runner must retain unrestricted generic MCP access",
  );
  assert.match(
    testRunnerBody,
    /exact ordered (?:validation|shell\/MCP) steps/,
    "test-runner must retain exact assigned validation steps",
  );
});

test("all bundled minor agents declare acceptance roles through runtime discovery", async (t) => {
  const definitions = readBundledDefinitions();
  assert.equal(
    definitions.length,
    9,
    "the bundled minor-agent inventory must cover all nine roles",
  );

  const names = definitions.map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length, "bundled minor-agent names must be unique");
  assert.equal(
    definitions.find((definition) => definition.name === "test-runner")?.tools,
    "bash, mcp",
    "test-runner must expose bash and the generic MCP gateway",
  );
  assert.ok(
    names.includes("developer"),
    "the bundled minor-agent inventory must include developer",
  );

  for (const definition of definitions) {
    assert.ok(
      definition.name,
      `${definition.relativePath} must declare a name in parsed frontmatter`,
    );
    assert.ok(
      definition.acceptanceRole === "read-only" || definition.acceptanceRole === "writer",
      `${definition.name} must declare acceptanceRole as read-only or writer`,
    );
    assert.equal(
      definition.acceptanceRole,
      definition.name === "developer" ? "writer" : "read-only",
      `${definition.name} must use its assigned acceptance role`,
    );
  }

  const { home, agentDir, workspace } = createBundledFixture(t, definitions);

  const discovered = await withEnv({ HOME: home, PI_CODING_AGENT_DIR: agentDir }, () =>
    discoverAgents(workspace, "user"),
  );
  assert.deepEqual(
    discovered.agentDiagnostics ?? [],
    [],
    "bundled declarations must pass the runtime parser without discovery diagnostics",
  );

  const discoveredByName = new Map(discovered.agents.map((agent) => [agent.name, agent]));
  assert.deepEqual(
    [...discoveredByName.keys()].sort(),
    [...names].sort(),
    "runtime discovery must load every dynamically discovered bundled definition",
  );
  for (const definition of definitions) {
    assert.equal(
      discoveredByName.get(definition.name)?.acceptanceRole,
      definition.acceptanceRole,
      `${definition.name} acceptanceRole must survive runtime discovery`,
    );
    assert.equal(
      discoveredByName.get(definition.name)?.override,
      undefined,
      `${definition.name} must retain no-override identity metadata`,
    );
  }
  assert.deepEqual(
    discoveredByName.get("test-runner")?.tools,
    ["bash", "mcp"],
    "runtime discovery must preserve test-runner's generic MCP gateway",
  );
});

test("canonical bundled roles accept profile and project acceptanceRole overrides", async (t) => {
  const definitions = readBundledDefinitions();
  const { home, agentDir, workspace } = createBundledFixture(t, definitions);
  const profileOverrides = {
    developer: { acceptanceRole: "read-only" },
    "code-reviewer": { acceptanceRole: "writer" },
    librarian: { acceptanceRole: false },
    oracle: { acceptanceRole: "writer" },
  };
  writeJson(join(agentDir, "settings.json"), {
    subagents: { agentOverrides: profileOverrides },
  });

  const profile = await withEnv({ HOME: home, PI_CODING_AGENT_DIR: agentDir }, () =>
    discoverAgents(workspace, "user"),
  );
  assertAcceptanceRoles(
    profile,
    definitions,
    {
      developer: "read-only",
      "code-reviewer": "writer",
      librarian: false,
      oracle: "writer",
    },
    "user",
  );

  const projectOverrides = {
    developer: { acceptanceRole: "writer" },
    "code-reviewer": { acceptanceRole: false },
    librarian: { acceptanceRole: "read-only" },
  };
  writeJson(join(workspace, ".pi", "settings.json"), {
    subagents: { agentOverrides: projectOverrides },
  });

  const both = await withEnv({ HOME: home, PI_CODING_AGENT_DIR: agentDir }, () =>
    discoverAgents(workspace, "both"),
  );
  assertAcceptanceRoles(
    both,
    definitions,
    {
      developer: "writer",
      "code-reviewer": false,
      librarian: "read-only",
      oracle: "writer",
    },
    "project",
    { oracle: "user" },
  );
  assert.equal(
    both.agents.find((agent) => agent.name === "oracle")?.override?.scope,
    "user",
    "an absent project entry must retain the selected profile override",
  );
});
