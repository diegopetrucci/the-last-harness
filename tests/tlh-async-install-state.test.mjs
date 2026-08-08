import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readTlhInstallStateAsync } = await jiti.import("../extensions/the-last-harness/profile-state.ts");
const { readTlhInstallNoticeAsync } = await jiti.import("../extensions/the-last-harness/install-state.ts");

/**
 * Set up a temp isolated profile so safeTlhProfileFilePath returns a valid path.
 * Returns a cleanup/restore function that resets env vars after the test.
 */
function withIsolatedProfile(agentDir) {
	const orig = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		HOME: process.env.HOME,
	};
	// Point to an isolated (non-default) agent dir so safeTlhProfileFilePath allows it.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// HOME must differ from agentDir's parent so isDefaultPiAgentDir returns false.
	return function restore() {
		if (orig.PI_CODING_AGENT_DIR === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = orig.PI_CODING_AGENT_DIR;
		}
	};
}

function makeTempAgentDir() {
	const base = mkdtempSync(join(tmpdir(), "tlh-async-install-state-test-"));
	const agentDir = join(base, "agent");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	const statePath = join(agentDir, "tlh", "install-state.json");
	return { base, agentDir, statePath };
}

const VALID_STATE = {
	repo: "diegopetrucci/the-last-harness",
	track: "latest-release",
	ref: "v0.10.0",
	packageSource: "git:github.com/diegopetrucci/the-last-harness@v0.10.0",
	packageSourceIsDefault: true,
};

test("readTlhInstallStateAsync returns parsed state for valid install-state JSON", async () => {
	const { agentDir, statePath } = makeTempAgentDir();
	writeFileSync(statePath, JSON.stringify(VALID_STATE), "utf8");
	const restore = withIsolatedProfile(agentDir);
	try {
		const state = await readTlhInstallStateAsync();
		assert.deepEqual(state, VALID_STATE);
	} finally {
		restore();
	}
});

test("readTlhInstallStateAsync returns {} when install-state file is missing", async () => {
	const { agentDir } = makeTempAgentDir();
	// Do not write statePath — file absent.
	const restore = withIsolatedProfile(agentDir);
	try {
		const state = await readTlhInstallStateAsync();
		assert.deepEqual(state, {});
	} finally {
		restore();
	}
});

test("readTlhInstallStateAsync returns {} for corrupt/invalid JSON", async () => {
	const { agentDir, statePath } = makeTempAgentDir();
	writeFileSync(statePath, "{ this is not valid json }", "utf8");
	const restore = withIsolatedProfile(agentDir);
	try {
		const state = await readTlhInstallStateAsync();
		assert.deepEqual(state, {});
	} finally {
		restore();
	}
});

test("readTlhInstallStateAsync returns {} when PI_CODING_AGENT_DIR is unset", async () => {
	const origDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		const state = await readTlhInstallStateAsync();
		assert.deepEqual(state, {});
	} finally {
		if (origDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = origDir;
		}
	}
});

test("readTlhInstallNoticeAsync returns undefined for official latest-stable installs", async () => {
	const { agentDir, statePath } = makeTempAgentDir();
	writeFileSync(statePath, JSON.stringify(VALID_STATE), "utf8");
	const restore = withIsolatedProfile(agentDir);
	try {
		const notice = await readTlhInstallNoticeAsync();
		assert.equal(notice, undefined);
	} finally {
		restore();
	}
});

test("readTlhInstallNoticeAsync returns unknown notice for missing install-state file", async () => {
	const { agentDir } = makeTempAgentDir();
	const restore = withIsolatedProfile(agentDir);
	try {
		const notice = await readTlhInstallNoticeAsync();
		assert.deepEqual(notice, {
			kind: "unknown",
			summary: "TLH install metadata is missing or invalid.",
		});
	} finally {
		restore();
	}
});

test("readTlhInstallNoticeAsync returns unknown notice for corrupt JSON", async () => {
	const { agentDir, statePath } = makeTempAgentDir();
	writeFileSync(statePath, "NOT JSON", "utf8");
	const restore = withIsolatedProfile(agentDir);
	try {
		const notice = await readTlhInstallNoticeAsync();
		assert.deepEqual(notice, {
			kind: "unknown",
			summary: "TLH install metadata is missing or invalid.",
		});
	} finally {
		restore();
	}
});

test("readTlhInstallNoticeAsync returns ref notice for ref-track installs", async () => {
	const { agentDir, statePath } = makeTempAgentDir();
	writeFileSync(
		statePath,
		JSON.stringify({
			...VALID_STATE,
			track: "ref",
			ref: "main",
			packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		}),
		"utf8",
	);
	const restore = withIsolatedProfile(agentDir);
	try {
		const notice = await readTlhInstallNoticeAsync();
		assert.deepEqual(notice, {
			kind: "ref",
			summary: "TLH follows a non-stable git ref.",
			detail: "main",
		});
	} finally {
		restore();
	}
});
