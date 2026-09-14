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

function readBundledDefinitions() {
  return listBundledMarkdownFiles(bundledAgentsRoot).map((filePath) => {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    return {
      filePath,
      relativePath: relative(bundledAgentsRoot, filePath),
      name: frontmatter.name,
      tools: frontmatter.tools,
      acceptanceRole: frontmatter.acceptanceRole,
    };
  });
}

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
