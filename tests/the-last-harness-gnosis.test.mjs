import assert from "node:assert/strict";
import { delimiter, join, sep } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { __testing } = await jiti.import("../extensions/the-last-harness/gnosis.ts");

test("gnosis prompt decision validates a bundled command once per resolved agent dir", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-gnosis-prompt-test-", { test: t });
	const unresolvedAgentDir = `${fixture.agent}${sep}.`;
	const bundledCommand = join(fixture.agent, "bin", "gn");
	const bundledBinDir = join(fixture.agent, "bin");
	const externalPath = join(fixture.dir, "external-bin");
	const calls = [];
	t.after(() => __testing.resetForTests());
	__testing.setGnosisHelpRunnerForTests((command, args) => {
		calls.push({ command, args });
	});

	await withEnv({ PATH: externalPath }, async () => {
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(unresolvedAgentDir), true);
		assert.equal(process.env.PATH?.split(delimiter)[0], bundledBinDir);
		process.env.PATH = externalPath;
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(fixture.agent), true);
		assert.deepEqual(calls, [
			{ command: bundledCommand, args: ["help", "plan"] },
			{ command: bundledCommand, args: ["help", "review"] },
		]);
		assert.equal(process.env.PATH?.split(delimiter)[0], bundledBinDir);
	});
});

test("gnosis prompt decision retries a cached failure after the negative TTL", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-gnosis-prompt-test-", { test: t });
	const unresolvedAgentDir = `${fixture.agent}${sep}.`;
	const bundledCommand = join(fixture.agent, "bin", "gn");
	const externalPath = join(fixture.dir, "external-bin");
	const calls = [];
	let now = 1_000;
	let available = false;
	t.after(() => __testing.resetForTests());
	__testing.setClockForTests(() => now);
	__testing.setGnosisHelpRunnerForTests((command, args) => {
		calls.push({ command, args });
		if (!available) {
			throw new Error("temporarily unavailable");
		}
	});

	await withEnv({ PATH: externalPath }, async () => {
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(unresolvedAgentDir), false);
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(fixture.agent), false);
		assert.deepEqual(calls, [
			{ command: bundledCommand, args: ["help", "plan"] },
			{ command: "gn", args: ["help", "plan"] },
		]);

		now += 30_000;
		available = true;
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(fixture.agent), true);
		assert.deepEqual(calls.slice(-2), [
			{ command: bundledCommand, args: ["help", "plan"] },
			{ command: bundledCommand, args: ["help", "review"] },
		]);

		now += 30_000;
		assert.equal(__testing.shouldAppendGnosisPromptForAgentDir(fixture.agent), true);
		assert.equal(calls.length, 4, "successful validation should remain cached after the negative TTL");
	});
});
