import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { collectStartupResourceSnapshot } = await jiti.import(
  "../extensions/the-last-harness/resources.ts",
);

function writeSkill(baseDir, name, skillRoot = ".pi/skills") {
  mkdirSync(join(baseDir, skillRoot, name), { recursive: true });
  writeFileSync(
    join(baseDir, skillRoot, name, "SKILL.md"),
    `---
name: ${name}
description: ${name}
---
${name} content
`,
    "utf8",
  );
}

function writeContextFile(baseDir, filename) {
  writeFileSync(join(baseDir, filename), `${filename} instructions`, "utf8");
}

function writeTrust(agentDir, trustByPath) {
  writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify(trustByPath, null, 2)}\n`, "utf8");
}

test("startup resources hide project-local skills when trust is unresolved", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-unresolved-", { cwd: true, test: t });
  const childCwd = join(fixture.cwd, "project");
  mkdirSync(childCwd, { recursive: true });
  writeSkill(fixture.cwd, "ancestor-skill", ".agents/skills");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const resources = (await collectStartupResourceSnapshot(childCwd)).resources;

    assert.deepEqual(resources.context, []);
    assert.deepEqual(resources.skills, []);
  });
});

test("startup resources show project-local inputs for an exact saved trust decision", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-trusted-", { cwd: true, test: t });
  writeContextFile(fixture.cwd, "AGENTS.md");
  writeSkill(fixture.cwd, "project-skill");
  writeTrust(fixture.agent, { [realpathSync(fixture.cwd)]: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const snapshot = await collectStartupResourceSnapshot(fixture.cwd);

    assert.deepEqual(snapshot.resources.context, ["AGENTS.md"]);
    assert.deepEqual(snapshot.resources.skills, ["project-skill"]);
    assert.deepEqual(snapshot.promptMetadata.contextFiles, [
      { path: join(fixture.cwd, "AGENTS.md"), content: "AGENTS.md instructions" },
    ]);
    assert.deepEqual(snapshot.promptMetadata.skills, [
      {
        name: "project-skill",
        description: "project-skill",
        filePath: join(fixture.cwd, ".pi", "skills", "project-skill", "SKILL.md"),
      },
    ]);
  });
});

test("startup resources inherit the nearest parent saved trust decision", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-parent-trust-", {
    cwd: true,
    test: t,
  });
  const childCwd = join(fixture.cwd, "project");
  mkdirSync(childCwd, { recursive: true });
  writeContextFile(childCwd, "AGENTS.md");
  writeSkill(childCwd, "project-skill");
  writeTrust(fixture.agent, {
    [realpathSync(fixture.cwd)]: true,
    [realpathSync(childCwd)]: null,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const resources = (await collectStartupResourceSnapshot(childCwd)).resources;

    assert.deepEqual(resources.context, ["AGENTS.md"]);
    assert.deepEqual(resources.skills, ["project-skill"]);
  });
});

test("startup resources let a nearer false trust override a parent true", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-child-false-", {
    cwd: true,
    test: t,
  });
  const childCwd = join(fixture.cwd, "project");
  mkdirSync(childCwd, { recursive: true });
  writeContextFile(childCwd, "AGENTS.md");
  writeSkill(childCwd, "project-skill");
  writeTrust(fixture.agent, {
    [realpathSync(fixture.cwd)]: true,
    [realpathSync(childCwd)]: false,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const resources = (await collectStartupResourceSnapshot(childCwd)).resources;

    assert.deepEqual(resources.context, ["AGENTS.md"]);
    assert.deepEqual(resources.skills, []);
  });
});

test("startup resources keep AGENTS.md and CLAUDE.md context visible when trust is unresolved", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-context-visible-", {
    cwd: true,
    test: t,
  });
  const childCwd = join(fixture.cwd, "project");
  mkdirSync(childCwd, { recursive: true });
  writeContextFile(fixture.cwd, "AGENTS.md");
  writeContextFile(childCwd, "CLAUDE.md");
  writeSkill(childCwd, "project-skill");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const resources = (await collectStartupResourceSnapshot(childCwd)).resources;

    assert.deepEqual(resources.context, [join(fixture.cwd, "AGENTS.md"), "CLAUDE.md"]);
    assert.deepEqual(resources.skills, []);
  });
});

test("startup resources surface only trusted project-agent guidance sources", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-project-guidance-", {
    cwd: true,
    test: t,
  });
  const guidancePath = join(fixture.cwd, ".tlh", "agents", "builtin", "ARCHITECT_PROMPT_APPEND.md");
  mkdirSync(join(fixture.cwd, ".tlh", "agents", "builtin"), { recursive: true });
  writeFileSync(guidancePath, "architect project guidance", "utf8");
  writeTrust(fixture.agent, { [realpathSync(fixture.cwd)]: true });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const snapshot = await collectStartupResourceSnapshot(fixture.cwd);

    assert.deepEqual(snapshot.resources.projectGuidance, [
      "architect: .tlh/agents/builtin/ARCHITECT_PROMPT_APPEND.md",
    ]);
  });
});

test("startup resources hide undecided project-agent guidance and retain an actionable diagnostic", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-project-guidance-", {
    cwd: true,
    test: t,
  });
  const guidancePath = join(fixture.cwd, ".tlh", "agents", "builtin", "ARCHITECT_PROMPT_APPEND.md");
  mkdirSync(join(fixture.cwd, ".tlh", "agents", "builtin"), { recursive: true });
  writeFileSync(guidancePath, "private project guidance", "utf8");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const snapshot = await collectStartupResourceSnapshot(fixture.cwd);

    assert.deepEqual(snapshot.resources.projectGuidance, []);
  });
});

test("startup resources use AGENTS.override.md for the nearest context and retain ancestor inheritance", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-resources-context-override-", {
    cwd: true,
    test: t,
  });
  const childCwd = join(fixture.cwd, "project");
  mkdirSync(childCwd, { recursive: true });
  writeFileSync(join(fixture.cwd, "AGENTS.md"), "ancestor context", "utf8");
  writeFileSync(join(childCwd, "AGENTS.md"), "ordinary child context", "utf8");
  writeFileSync(join(childCwd, "CLAUDE.md"), "claude child context", "utf8");
  writeFileSync(join(childCwd, "AGENTS.override.md"), "override child context", "utf8");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const contextFiles = loadProjectContextFiles({ cwd: childCwd, agentDir: fixture.agent });
    assert.deepEqual(
      contextFiles.map(({ path, content }) => ({ path, content })),
      [
        { path: join(fixture.cwd, "AGENTS.md"), content: "ancestor context" },
        { path: join(childCwd, "AGENTS.override.md"), content: "override child context" },
      ],
    );

    const resources = (await collectStartupResourceSnapshot(childCwd, { projectTrusted: true }))
      .resources;
    assert.deepEqual(resources.context, [join(fixture.cwd, "AGENTS.md"), "AGENTS.override.md"]);
  });
});
