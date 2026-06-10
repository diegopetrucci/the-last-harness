import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { collectStartupResources } = await jiti.import("../extensions/the-last-harness/resources.ts");

function writeProjectResources(cwd) {
	writeFileSync(join(cwd, "AGENTS.md"), "Project instructions", "utf8");
	mkdirSync(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
		`---
name: project-skill
description: Project skill
---
Project skill content
`,
		"utf8",
	);
}

test("startup resources hide project-local inputs when Pi project trust is unresolved", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-untrusted-", { cwd: true, test: t });
	writeProjectResources(fixture.cwd);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(fixture.cwd, { piVersion: "0.79.0" });

		assert.deepEqual(resources.context, []);
		assert.deepEqual(resources.skills, []);
	});
});

test("startup resources show project-local inputs when Pi project trust is saved", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-trusted-", { cwd: true, test: t });
	writeProjectResources(fixture.cwd);
	writeFileSync(
		join(fixture.agent, "trust.json"),
		`${JSON.stringify({ [realpathSync(fixture.cwd)]: true }, null, 2)}\n`,
		"utf8",
	);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(fixture.cwd, { piVersion: "0.79.0" });

		assert.deepEqual(resources.context, ["AGENTS.md"]);
		assert.deepEqual(resources.skills, ["project-skill"]);
	});
});

test("startup resources keep project-local inputs for older Pi versions without project trust", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-resources-pre-trust-", { cwd: true, test: t });
	writeProjectResources(fixture.cwd);

	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const resources = await collectStartupResources(fixture.cwd, { piVersion: "0.78.1" });

		assert.deepEqual(resources.context, ["AGENTS.md"]);
		assert.deepEqual(resources.skills, ["project-skill"]);
	});
});
