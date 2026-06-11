import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { collectStartupResources } = await jiti.import("../extensions/the-last-harness/resources.ts");

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
		const resources = await collectStartupResources(childCwd);

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
		const resources = await collectStartupResources(fixture.cwd);

		assert.deepEqual(resources.context, ["AGENTS.md"]);
		assert.deepEqual(resources.skills, ["project-skill"]);
	});
});

test("startup resources inherit the nearest parent saved trust decision", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-parent-trust-", { cwd: true, test: t });
	const childCwd = join(fixture.cwd, "project");
	mkdirSync(childCwd, { recursive: true });
	writeContextFile(childCwd, "AGENTS.md");
	writeSkill(childCwd, "project-skill");
	writeTrust(fixture.agent, {
		[realpathSync(fixture.cwd)]: true,
		[realpathSync(childCwd)]: null,
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(childCwd);

		assert.deepEqual(resources.context, ["AGENTS.md"]);
		assert.deepEqual(resources.skills, ["project-skill"]);
	});
});

test("startup resources let a nearer false trust override a parent true", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-child-false-", { cwd: true, test: t });
	const childCwd = join(fixture.cwd, "project");
	mkdirSync(childCwd, { recursive: true });
	writeContextFile(childCwd, "AGENTS.md");
	writeSkill(childCwd, "project-skill");
	writeTrust(fixture.agent, {
		[realpathSync(fixture.cwd)]: true,
		[realpathSync(childCwd)]: false,
	});

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(childCwd);

		assert.deepEqual(resources.context, ["AGENTS.md"]);
		assert.deepEqual(resources.skills, []);
	});
});

test("startup resources keep AGENTS.md and CLAUDE.md context visible when trust is unresolved", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-context-visible-", { cwd: true, test: t });
	const childCwd = join(fixture.cwd, "project");
	mkdirSync(childCwd, { recursive: true });
	writeContextFile(fixture.cwd, "AGENTS.md");
	writeContextFile(childCwd, "CLAUDE.md");
	writeSkill(childCwd, "project-skill");

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(childCwd);

		assert.deepEqual(resources.context, [join(fixture.cwd, "AGENTS.md"), "CLAUDE.md"]);
		assert.deepEqual(resources.skills, []);
	});
});
