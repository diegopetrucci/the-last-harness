import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createSafeTlhProfileWritePlan, writeSafeTlhProfileFile } from "../scripts/lib/tlh-profile-writes.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

test("createSafeTlhProfileWritePlan freezes plans and shim writes nested files with safe defaults", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const nestedTarget = join(fixture.agent, "nested", "settings.json");
	const explicitTarget = join(fixture.agent, "nested", "state.json");
	const nestedPlan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath: nestedTarget,
		homeDir: fixture.home,
		label: "isolated settings",
	});

	assert.equal(Object.isFrozen(nestedPlan), true);
	assert.equal(nestedPlan.agentDir, fixture.agent);
	assert.equal(nestedPlan.agentRoot, fixture.agent);
	assert.equal(nestedPlan.relativePath, "nested/settings.json");

	writeSafeTlhProfileFile(nestedPlan, '{\n  "tlh": true\n}\n');
	assert.equal(readFileSync(nestedTarget, "utf8"), '{\n  "tlh": true\n}\n');
	assert.equal(lstatSync(nestedTarget).mode & 0o777, 0o600);

	const explicitPlan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath: explicitTarget,
		homeDir: fixture.home,
		label: "isolated state",
	});
	writeSafeTlhProfileFile(explicitPlan, "ok\n", { mode: 0o640 });
	assert.equal(readFileSync(explicitTarget, "utf8"), "ok\n");
	assert.equal(lstatSync(explicitTarget).mode & 0o777, 0o640);

	const legacyTarget = join(fixture.agent, "legacy", "state.json");
	writeSafeTlhProfileFile(
		{
			agentRoot: fixture.agent,
			label: "legacy state",
			targetPath: legacyTarget,
		},
		"legacy\n",
	);
	assert.equal(readFileSync(legacyTarget, "utf8"), "legacy\n");
});

test("createSafeTlhProfileWritePlan rejects protected, outside-profile, and profile-root targets", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });

	assert.throws(
		() =>
			createSafeTlhProfileWritePlan({
				agentDir: fixture.agent,
				targetPath: fixture.agent,
				homeDir: fixture.home,
				label: "isolated settings",
			}),
		/refusing to write isolated settings over the configured TLH profile directory/,
	);
	assert.throws(
		() =>
			createSafeTlhProfileWritePlan({
				agentDir: fixture.agent,
				targetPath: join(fixture.dir, "outside", "settings.json"),
				homeDir: fixture.home,
				label: "isolated settings",
			}),
		/refusing to write isolated settings outside the configured TLH profile path/,
	);
	assert.throws(
		() =>
			createSafeTlhProfileWritePlan({
				agentDir: join(fixture.home, ".pi", "agent"),
				targetPath: join(fixture.home, ".pi", "agent", "settings.json"),
				homeDir: fixture.home,
				label: "isolated settings",
			}),
		/refusing to write isolated settings under normal Pi config root/,
	);
});

test("writeSafeTlhProfileFile rejects malformed and forged compatibility plans", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const targetPath = join(fixture.agent, "nested", "settings.json");
	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath,
		homeDir: fixture.home,
		label: "isolated settings",
	});

	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, relativePath: "../outside.json" }, "bad\n"),
		/refusing unsafe isolated settings/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, relativePath: "other.json" }, "bad\n"),
		/forged compatibility plan target/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, relativePath: 42 }, "bad\n"),
		/malformed compatibility plan relative path/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, targetPath: join(fixture.dir, "outside", "settings.json") }, "bad\n"),
		/mismatched compatibility plan target parent/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, targetPath: fixture.agent }, "bad\n"),
		/mismatched compatibility plan target parent/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, agentDir: fixture.dir }, "bad\n"),
		/mismatched compatibility plan profile roots/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, intendedAgentDir: fixture.dir }, "bad\n"),
		/mismatched compatibility plan intended profile root/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, targetParent: fixture.dir }, "bad\n"),
		/mismatched compatibility plan target parent/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ ...plan, intendedTargetParent: fixture.dir }, "bad\n"),
		/mismatched compatibility plan intended target parent/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile({ agentDir: fixture.agent, label: "isolated settings" }, "bad\n"),
		/malformed compatibility plan/,
	);
	for (const anchor of ["agentRoot", "agentDir", "intendedAgentDir", "targetParent", "intendedTargetParent"]) {
		assert.throws(
			() => writeSafeTlhProfileFile({ ...plan, [anchor]: 42 }, "bad\n"),
			new RegExp(`malformed compatibility plan ${anchor}`),
		);
	}
	assert.equal(existsSync(targetPath), false);
	assert.equal(existsSync(join(fixture.dir, "outside", "settings.json")), false);
});

test("writeSafeTlhProfileFile rejects cloned plans redirected away from their intent anchors", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const originalTarget = join(fixture.agent, "nested", "settings.json");
	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath: originalTarget,
		homeDir: fixture.home,
		label: "isolated settings",
	});
	const externalDir = join(fixture.dir, "external");
	const externalTarget = join(externalDir, "settings.json");
	const sentinel = join(externalDir, "sentinel.txt");
	mkdirSync(externalDir, { recursive: true });
	writeFileSync(sentinel, "unchanged\n");

	assert.throws(
		() =>
			writeSafeTlhProfileFile(
				{
					...plan,
					agentRoot: externalDir,
					relativePath: "settings.json",
					targetPath: externalTarget,
				},
				"forged\n",
			),
		/mismatched compatibility plan profile roots/,
	);
	assert.equal(existsSync(externalTarget), false);
	assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
	assert.equal(existsSync(originalTarget), false);
});

test("writeSafeTlhProfileFile does not trust a forged plan home when guarding normal Pi config", {
	concurrency: false,
}, async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const protectedAgentDir = join(fixture.home, ".pi", "agent");
	const protectedTarget = join(protectedAgentDir, "settings.json");
	const forgedPlan = {
		agentDir: protectedAgentDir,
		agentRoot: protectedAgentDir,
		homeDir: join(fixture.dir, "decoy-home"),
		label: "isolated settings",
		relativePath: "settings.json",
		targetPath: protectedTarget,
	};

	await withEnv({ HOME: fixture.home }, async () => {
		assert.throws(
			() => writeSafeTlhProfileFile(forgedPlan, "blocked\n"),
			/refusing to write isolated settings parent directory under normal Pi config root/,
		);
	});
	assert.equal(existsSync(protectedTarget), false);
});

test("writeSafeTlhProfileFile rejects invalid modes, unsafe modes, and exclusive writes", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath: join(fixture.agent, "nested", "settings.json"),
		homeDir: fixture.home,
		label: "isolated settings",
	});

	assert.throws(() => writeSafeTlhProfileFile(plan, "bad\n", { mode: 0o1000 }), /invalid file mode/);
	assert.throws(
		() => writeSafeTlhProfileFile(plan, "bad\n", { mode: 0o666 }),
		/unsafe group\/world-writable file mode/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile(plan, "bad\n", { mode: 0o620 }),
		/unsafe group\/world-writable file mode/,
	);
	assert.throws(
		() => writeSafeTlhProfileFile(plan, "bad\n", { exclusive: true }),
		/exclusive mode through the stale compatibility shim/,
	);
	assert.equal(existsSync(join(fixture.agent, "nested", "settings.json")), false);
});

test("writeSafeTlhProfileFile delegates symlink safety to the underlying safe writer", (t) => {
	const fixture = createIsolatedProfileFixture("tlh-profile-writes-", { test: t });
	const externalDir = join(fixture.dir, "external");
	const symlinkedParent = join(fixture.agent, "nested");
	const targetPath = join(symlinkedParent, "settings.json");
	mkdirSync(externalDir, { recursive: true });
	symlinkSync(externalDir, symlinkedParent, "dir");

	const plan = createSafeTlhProfileWritePlan({
		agentDir: fixture.agent,
		targetPath,
		homeDir: fixture.home,
		label: "isolated settings",
	});

	assert.throws(
		() => writeSafeTlhProfileFile(plan, "blocked\n"),
		/refusing to write isolated settings parent directory through symlinked TLH profile path/,
	);
	assert.equal(existsSync(join(externalDir, "settings.json")), false);
});
