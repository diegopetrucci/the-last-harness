import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: theLastHarness } = await jiti.import("../extensions/the-last-harness.ts");

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const PINNED_TAG_INSTALL_STATE = {
	repo: "diegopetrucci/the-last-harness",
	track: "pinned-tag",
	ref: "v0.10.0",
	packageSource: "git:github.com/diegopetrucci/the-last-harness@v0.10.0",
	packageSourceIsDefault: true,
};

const PINNED_TAG_LOCAL_INSTALL_STATE = {
	...PINNED_TAG_INSTALL_STATE,
	packageSource: "../the-last-harness",
	packageSourceIsDefault: false,
};

const LATEST_STABLE_INSTALL_STATE = {
	...PINNED_TAG_INSTALL_STATE,
	track: "latest-release",
};

function createPi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		getAllTools: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
	};
}

function createCtx({ cwd, notifications, hasUI = true, onSetHeader }) {
	return {
		hasUI,
		cwd,
		model: undefined,
		modelRegistry: {
			isUsingOAuth: () => false,
			getApiKeyForProvider: async () => undefined,
			find: () => undefined,
			authStorage: { get: () => undefined },
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => cwd,
			getSessionName: () => undefined,
			getBranch: () => undefined,
		},
		getContextUsage: () => undefined,
		ui: {
			addAutocompleteProvider() {},
			setFooter() {},
			setHeader(factory) {
				onSetHeader?.(factory);
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			getEditorText: () => "",
		},
		isIdle: () => true,
	};
}

function restoreEnv(previousEnv) {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function writeProfileFixture(agentDir, installState) {
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, telemetry: { enabled: false }, updateCheck: { enabled: false } } }, null, 2)}\n`,
	);
	writeFileSync(join(agentDir, "tlh", "install-state.json"), `${JSON.stringify(installState, null, 2)}\n`);
}

async function runSessionStart({ reason, installState, hasUI = true }) {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-startup-warning-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	const previousEnv = {
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
		TLH_SKIP_TELEMETRY: process.env.TLH_SKIP_TELEMETRY,
	};

	try {
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.TLH_SKIP_UPDATE_CHECK = "1";
		process.env.TLH_SKIP_TELEMETRY = "1";
		mkdirSync(cwd, { recursive: true });
		writeProfileFixture(agentDir, installState);

		const pi = createPi();
		theLastHarness(pi);
		const notifications = [];
		let headerFactory;
		const ctx = createCtx({
			cwd,
			notifications,
			hasUI,
			onSetHeader(factory) {
				headerFactory = factory;
			},
		});
		const sessionStartHandlers = pi.handlers.get("session_start") ?? [];
		assert.ok(sessionStartHandlers.length > 0, "session_start handler must be registered by the extension");

		for (const handler of sessionStartHandlers) {
			await handler({ reason }, ctx);
		}
		await new Promise((resolve) => setImmediate(resolve));
		const headerLines = headerFactory ? headerFactory({ requestRender() {} }, theme).render(200) : undefined;
		return { notifications, headerLines };
	} finally {
		restoreEnv(previousEnv);
		rmSync(tempDir, { recursive: true, force: true });
	}
}

test("interactive startup renders the non-latest track warning in the TLH header", async () => {
	const { notifications, headerLines } = await runSessionStart({ reason: "startup", installState: PINNED_TAG_INSTALL_STATE });

	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.ok(headerLines.includes("Warning: running TLH from v0.10.0 track"));
});

test("interactive startup prefers the pinned ref label over a local package-source label", async () => {
	const { notifications, headerLines } = await runSessionStart({ reason: "startup", installState: PINNED_TAG_LOCAL_INSTALL_STATE });

	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.ok(headerLines.includes("Warning: running TLH from v0.10.0 track"));
});

test("interactive startup stays quiet for latest-stable installs", async () => {
	const { notifications, headerLines } = await runSessionStart({ reason: "startup", installState: LATEST_STABLE_INSTALL_STATE });
	assert.deepEqual(notifications, []);
	assert.ok(headerLines);
	assert.equal(headerLines.some((line) => line.startsWith("Warning:")), false);
});

test("non-startup session reasons do not render the install-track warning in the TLH header", async () => {
	for (const reason of ["reload", "new", "resume", "fork"]) {
		const { notifications, headerLines } = await runSessionStart({ reason, installState: PINNED_TAG_INSTALL_STATE });
		assert.deepEqual(notifications, [], `expected no install warning notification for ${reason}`);
		assert.ok(headerLines, `expected TLH header for ${reason}`);
		assert.equal(
			headerLines.some((line) => line.startsWith("Warning:")),
			false,
			`expected no install-track warning in header for ${reason}`,
		);
	}
});

test("startup without UI does not show the install-track notice", async () => {
	const { notifications, headerLines } = await runSessionStart({ reason: "startup", installState: PINNED_TAG_INSTALL_STATE, hasUI: false });
	assert.deepEqual(notifications, []);
	assert.equal(headerLines, undefined);
});
