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
};

const footerData = {
	getGitBranch: () => undefined,
	getAvailableProviderCount: () => 1,
	getExtensionStatuses: () => new Map(),
};

function createPi() {
	const handlers = new Map();
	let activeTools = ["read", "grep", "find", "ls", "bash", "subagent", "intercom"];
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		getAllTools: () => activeTools.map((name) => ({ name })),
		getActiveTools: () => activeTools,
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
	};
}

function createCtx(options) {
	return {
		hasUI: true,
		cwd: options.cwd,
		model: { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200000 },
		modelRegistry: {
			isUsingOAuth: (model) => model?.provider === "anthropic",
			getApiKeyForProvider: async (provider) => (provider === "anthropic" ? options.currentAccessToken() : undefined),
			find: () => undefined,
			authStorage: options.authStorage,
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => options.cwd,
			getSessionName: () => undefined,
			getBranch: () => undefined,
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 12.3 }),
		ui: {
			addAutocompleteProvider() {},
			setFooter(factory) {
				factory({ requestRender: options.requestRender }, theme, footerData);
			},
			setHeader() {},
			notify() {},
			getEditorText: () => "",
		},
		isIdle: () => true,
	};
}

async function eventually(predicate, message) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.ok(predicate(), message);
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

test("subscription usage refresh requests a footer render when a runtime override clears active usage", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-refresh-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	const previousEnv = {
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
	};
	const previousFetch = globalThis.fetch;

	let fetchCalls = 0;
	let renderRequests = 0;
	let returnedAccessToken = "oauth-access-token";
	const credential = { type: "oauth", access: "oauth-access-token" };
	const authStorage = {
		runtimeOverrides: new Map(),
		get: (provider) => (provider === "anthropic" ? credential : undefined),
	};

	try {
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.TLH_SKIP_UPDATE_CHECK = "1";
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
		);

		globalThis.fetch = async () => {
			fetchCalls += 1;
			return {
				ok: true,
				json: async () => ({ five_hour: { used: 4, limit: 10 } }),
			};
		};

		const pi = createPi();
		theLastHarness(pi);
		const ctxOptions = {
			cwd,
			authStorage,
			currentAccessToken: () => returnedAccessToken,
			requestRender: () => {
				renderRequests += 1;
			},
		};
		const ctx = createCtx(ctxOptions);

		await pi.handlers.get("session_start")?.[0]?.({ reason: "restore" }, ctx);
		await eventually(() => fetchCalls === 1 && renderRequests === 1, "initial usage fetch should request one footer render");

		renderRequests = 0;
		returnedAccessToken = "runtime-api-key";
		authStorage.runtimeOverrides.set("anthropic", "runtime-api-key");

		pi.handlers.get("model_select")?.[0]?.({}, ctx);
		await eventually(() => renderRequests === 1, "clearing active usage should request a footer render");
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = previousFetch;
		restoreEnv(previousEnv);
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("rapid turn_end burst collapses to a single fetch and no extra renders when the snapshot is unchanged", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-usage-burst-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	const previousEnv = {
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		TLH_SKIP_UPDATE_CHECK: process.env.TLH_SKIP_UPDATE_CHECK,
	};
	const previousFetch = globalThis.fetch;

	let fetchCalls = 0;
	let renderRequests = 0;
	const credential = { type: "oauth", access: "oauth-access-token" };
	const authStorage = {
		runtimeOverrides: new Map(),
		get: (provider) => (provider === "anthropic" ? credential : undefined),
	};

	try {
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.TLH_SKIP_UPDATE_CHECK = "1";
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" }, updateCheck: { enabled: false } } }, null, 2)}\n`,
		);

		globalThis.fetch = async () => {
			fetchCalls += 1;
			return {
				ok: true,
				json: async () => ({ five_hour: { used: 4, limit: 10 } }),
			};
		};

		const pi = createPi();
		theLastHarness(pi);
		const ctx = createCtx({
			cwd,
			authStorage,
			currentAccessToken: () => "oauth-access-token",
			requestRender: () => {
				renderRequests += 1;
			},
		});

		// session_start primes the snapshot and the throttle bookkeeping so the
		// subsequent turn_end burst exercises the steady-state path the user
		// actually triggers between turns.
		await pi.handlers.get("session_start")?.[0]?.({ reason: "restore" }, ctx);
		await eventually(
			() => fetchCalls === 1 && renderRequests === 1,
			"initial usage fetch should populate the snapshot before the burst",
		);

		// Reset render bookkeeping so we can prove the burst itself emits zero
		// renders. fetchCalls intentionally stays at 1 so the final assertion
		// captures the total network call count across the whole lifecycle.
		renderRequests = 0;

		const turnEndHandler = pi.handlers.get("turn_end")?.[0];
		assert.ok(turnEndHandler, "turn_end handler must be registered by the extension");

		// Production wiring registers turn_end as a synchronous handler that
		// fires refreshSubscriptionUsage() without awaiting, so we mirror that
		// by invoking it 20 times in a tight loop without yielding between
		// calls. This is the worst-case shape of a real burst.
		for (let i = 0; i < 20; i += 1) {
			turnEndHandler({}, ctx);
		}

		// Drain microtasks once. Node flushes the entire microtask queue
		// before running setImmediate, so every queued refresh() promise chain
		// resolves before we assert.
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(
			fetchCalls,
			1,
			"a rapid turn_end burst must not produce additional fetches (throttle + in-flight dedupe collapse the storm)",
		);
		assert.equal(
			renderRequests,
			0,
			"a rapid turn_end burst must not request renders when the snapshot and eligibility are unchanged",
		);
	} finally {
		globalThis.fetch = previousFetch;
		restoreEnv(previousEnv);
		rmSync(tempDir, { recursive: true, force: true });
	}
});
