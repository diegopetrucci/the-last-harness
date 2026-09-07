import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
      acceptanceRole: frontmatter.acceptanceRole,
    };
  });
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
  }
});
