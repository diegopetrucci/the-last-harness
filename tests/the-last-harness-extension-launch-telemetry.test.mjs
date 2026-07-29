import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { TLH_LAUNCH_TELEMETRY_EVENT_TYPE, TLH_NAME, TLH_TELEMETRY_STATE_SCHEMA_VERSION } = await jiti.import("../extensions/the-last-harness/constants.ts");
const { CI_FAILURE_INVESTIGATION_FEATURE, DELTA_FOLLOW_UP_REVIEWS_FEATURE, EMBEDDED_SUBAGENTS_FEATURE } = await jiti.import(
	"../extensions/the-last-harness/experimental.ts",
);
const { THINKING_LEVELS } = await jiti.import("../extensions/the-last-harness/constants.ts");
const { privacySafeTlhTelemetryProviderId, privacySafeTlhTelemetryThinkingLevel, scheduleTlhLaunchTelemetry, sendTlhLaunchTelemetry } = await jiti.import(
	"../extensions/the-last-harness/launch-telemetry.ts",
);

const EXISTING_INSTALL_ID = "11111111-1111-4111-8111-111111111111";

function telemetryStatePath(fixture) {
	return join(fixture.agent, "tlh", "telemetry-state.json");
}

function writeTelemetryState(fixture, installId = EXISTING_INSTALL_ID) {
	mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
	const stateContent = `${JSON.stringify({ schemaVersion: TLH_TELEMETRY_STATE_SCHEMA_VERSION, installId }, null, 2)}\n`;
	writeFileSync(telemetryStatePath(fixture), stateContent);
	return stateContent;
}

test("launch telemetry sends allowlisted experimental feature states and reuses the existing install ID", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	const originalState = writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify(
			{ tlh: { experimental: { enabledFeatures: [" delta-follow-up-reviews ", "legacy-flag"] } } },
			null,
			2,
		)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace/",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "openai-codex",
					modelId: "openai-codex/gpt-4o",
					primaryAgentName: "architect",
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	assert.equal(request.url, "https://telemetry.example.test/namespace/test-namespace/");
	assert.equal(request.options?.method, "POST");
	assert.equal(request.options?.headers?.["User-Agent"], `${TLH_NAME}/1.2.3`);

	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.appID, "test-app-id");
	assert.equal(event.type, TLH_LAUNCH_TELEMETRY_EVENT_TYPE);
	assert.equal(event.clientUser, createHash("sha256").update(EXISTING_INSTALL_ID).digest("hex"));
	assert.equal(event.payload["Tlh.App.version"], "1.2.3");
	assert.equal(event.payload["Tlh.Runtime.provider"], "openai-codex");
	assert.equal(event.payload["Tlh.Runtime.model"], "gpt-4o");
	assert.equal(event.payload["Tlh.PrimaryAgent.name"], "architect");
	assert.equal(event.payload[`Tlh.Experimental.${DELTA_FOLLOW_UP_REVIEWS_FEATURE}`], "on");
	assert.equal(event.payload[`Tlh.Experimental.${CI_FAILURE_INVESTIGATION_FEATURE}`], "off");
	assert.equal(event.payload[`Tlh.Experimental.${EMBEDDED_SUBAGENTS_FEATURE}`], "off");
	assert.equal(Object.hasOwn(event.payload, "Tlh.Experimental.legacy-flag"), false);
	assert.equal(readFileSync(telemetryStatePath(fixture), "utf8"), originalState);
});

test("launch telemetry allowlists current public runtime provider IDs and rejects stale aliases", () => {
	assert.equal(privacySafeTlhTelemetryProviderId("amazon-bedrock"), "amazon-bedrock");
	assert.equal(privacySafeTlhTelemetryProviderId("azure-openai-responses"), "azure-openai-responses");
	assert.equal(privacySafeTlhTelemetryProviderId("github-copilot"), "github-copilot");
	assert.equal(privacySafeTlhTelemetryProviderId("google-vertex"), "google-vertex");
	assert.equal(privacySafeTlhTelemetryProviderId("radius"), "radius");
	assert.equal(privacySafeTlhTelemetryProviderId("llama.cpp"), "llama.cpp");
	assert.equal(privacySafeTlhTelemetryProviderId("azure-openai"), "custom");
	assert.equal(privacySafeTlhTelemetryProviderId("bedrock"), "custom");
});

test("launch telemetry maps unknown provider and primary-agent identifiers to custom", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	writeTelemetryState(fixture);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "acme-internal",
					modelId: "acme-internal/super-secret-model",
					primaryAgentName: "skunkworks",
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Runtime.provider"], "custom");
	assert.equal(event.payload["Tlh.Runtime.model"], "custom");
	assert.equal(event.payload["Tlh.PrimaryAgent.name"], "custom");
});

test("launch telemetry skips when the isolated profile has telemetry opt-out enabled", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { telemetry: { enabled: false }, experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(fetchCalls, 0);
});

test("launch telemetry checks opt-out before collecting OS metadata", () => {
	const source = readFileSync(new URL("../extensions/the-last-harness/launch-telemetry.ts", import.meta.url), "utf8");
	const functionSource = source.match(/export async function sendTlhLaunchTelemetry\(snapshot: TlhTelemetrySnapshot\): Promise<void> \{[\s\S]*?\n\}/)?.[0];

	assert.ok(functionSource, "expected sendTlhLaunchTelemetry source");
	const skipCheckIndex = functionSource.indexOf("if (shouldSkipTlhLaunchTelemetry(launchSettings))");
	const osMetadataIndex = functionSource.indexOf("const osMetadata = await getTlhOsMetadata();");
	assert.notEqual(skipCheckIndex, -1);
	assert.notEqual(osMetadataIndex, -1);
	assert.ok(skipCheckIndex < osMetadataIndex, "expected opt-out check before OS metadata collection");
});

test("launch telemetry skips when telemetry settings are malformed", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-test-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ tlh: { telemetry: { enabled: "nope" }, experimental: { enabledFeatures: [DELTA_FOLLOW_UP_REVIEWS_FEATURE] } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = async () => {
		fetchCalls += 1;
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(fetchCalls, 0);
});

// ── Environment opt-out tests ─────────────────────────────────────────────────
//
// Each row exercises one independent opt-out path. The truthy flags use isTruthyEnvFlag
// ("1", "true", "yes" are the accepted values). PI_TELEMETRY uses isFalseyEnvFlag ("0",
// "false", "no" suppress telemetry; a truthy value like "1" must NOT suppress it).
//
// The table format keeps coverage compact and makes the semantics obvious at a glance.
//
// Existing tlh.telemetry.enabled:false coverage stays in the test above; this table
// covers only the environment-variable paths.

const ENV_OPT_OUT_CASES = [
	// [description, envOverride, expectedFetchCalls]
	[
		"PI_OFFLINE=1 (truthy flag) suppresses send",
		{ PI_OFFLINE: "1", TLH_SKIP_TELEMETRY: undefined, TLH_TELEMETRY_DISABLED: undefined, PI_TELEMETRY: undefined },
		0,
	],
	[
		"TLH_SKIP_TELEMETRY=true (truthy flag) suppresses send",
		{ PI_OFFLINE: undefined, TLH_SKIP_TELEMETRY: "true", TLH_TELEMETRY_DISABLED: undefined, PI_TELEMETRY: undefined },
		0,
	],
	[
		"TLH_TELEMETRY_DISABLED=yes (truthy flag) suppresses send",
		{ PI_OFFLINE: undefined, TLH_SKIP_TELEMETRY: undefined, TLH_TELEMETRY_DISABLED: "yes", PI_TELEMETRY: undefined },
		0,
	],
	[
		"PI_TELEMETRY=0 (falsey flag) suppresses send",
		{ PI_OFFLINE: undefined, TLH_SKIP_TELEMETRY: undefined, TLH_TELEMETRY_DISABLED: undefined, PI_TELEMETRY: "0" },
		0,
	],
	[
		"PI_TELEMETRY=1 (truthy value) does NOT suppress send",
		{ PI_OFFLINE: undefined, TLH_SKIP_TELEMETRY: undefined, TLH_TELEMETRY_DISABLED: undefined, PI_TELEMETRY: "1" },
		1,
	],
];

for (const [description, envOverride, expectedFetchCalls] of ENV_OPT_OUT_CASES) {
	test(`launch telemetry env opt-out: ${description}`, async (t) => {
		const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-env-optout-", { test: t });
		writeTelemetryState(fixture);

		const previousFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			return { ok: true, status: 200, statusText: "OK" };
		};

		try {
			await withEnv(
				{
					HOME: fixture.home,
					PI_CODING_AGENT_DIR: fixture.agent,
					TLH_TELEMETRY_NAMESPACE: "test-namespace",
					TLH_TELEMETRY_APP_ID: "test-app-id",
					TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
					...envOverride,
				},
				async () => {
					await sendTlhLaunchTelemetry({ version: "1.2.3", modelId: "gpt-4o" });
				},
			);
		} finally {
			globalThis.fetch = previousFetch;
		}

		assert.equal(fetchCalls, expectedFetchCalls, description);
	});
}

// ── privacySafeTlhTelemetryThinkingLevel tests ───────────────────────────────

test("privacySafeTlhTelemetryThinkingLevel maps all seven THINKING_LEVELS allowlist values to themselves", () => {
	for (const level of THINKING_LEVELS) {
		assert.equal(privacySafeTlhTelemetryThinkingLevel(level), level, `expected allowlisted value for "${level}"`);
	}
});

test("privacySafeTlhTelemetryThinkingLevel maps missing/empty/non-string to unknown", () => {
	assert.equal(privacySafeTlhTelemetryThinkingLevel(undefined), "unknown");
	assert.equal(privacySafeTlhTelemetryThinkingLevel(""), "unknown");
	assert.equal(privacySafeTlhTelemetryThinkingLevel("   "), "unknown");
});

test("privacySafeTlhTelemetryThinkingLevel maps unrecognised values to custom", () => {
	assert.equal(privacySafeTlhTelemetryThinkingLevel("ultra"), "custom");
	assert.equal(privacySafeTlhTelemetryThinkingLevel("MEDIUM"), "custom");
	assert.equal(privacySafeTlhTelemetryThinkingLevel("turbo"), "custom");
});

// ── Tlh.Runtime.thinking tests ───────────────────────────────────────────────

test("launch telemetry emits Tlh.Runtime.thinking from snapshot.thinkingLevel", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-thinking-", { test: t });
	writeTelemetryState(fixture);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					modelId: "claude-opus-4-5",
					thinkingLevel: "high",
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Runtime.thinking"], "high");
});

test("launch telemetry maps unknown thinkingLevel to unknown and uppercase value to custom", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-thinking-", { test: t });
	writeTelemetryState(fixture);

	const previousFetch = globalThis.fetch;
	const results = {};
	globalThis.fetch = async (url, options) => {
		const [event] = JSON.parse(options?.body ?? "[]");
		results[event.payload["Tlh.App.version"]] = event.payload["Tlh.Runtime.thinking"];
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "missing", thinkingLevel: undefined });
				await sendTlhLaunchTelemetry({ version: "uppercase", thinkingLevel: "High" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.equal(results["missing"], "unknown", "undefined thinkingLevel should map to unknown");
	assert.equal(results["uppercase"], "custom", "uppercase 'High' should map to custom (case-sensitive check)");
});

// ── Tlh.Subagent.NAME.{thinking,model} tests ─────────────────────────────────

test("launch telemetry emits all eight bundled subagent keys with unknown when no config present", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	const bundledNames = ["code-reviewer", "contrarian", "developer", "diff-summarizer", "librarian", "oracle", "repo-scout", "web-scout"];
	for (const name of bundledNames) {
		assert.equal(event.payload[`Tlh.Subagent.${name}.thinking`], "unknown", `expected unknown thinking for ${name}`);
		assert.equal(event.payload[`Tlh.Subagent.${name}.model`], "unknown", `expected unknown model for ${name}`);
	}
});

test("launch telemetry reflects settings agentOverrides thinking change", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({
			subagents: { agentOverrides: { developer: { thinking: "high", model: "claude-opus-4-5" } } },
		}, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "high", "settings override thinking should be reflected");
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "claude-opus-4-5", "settings override model should be reflected");
	// Other agents should still be unknown
	assert.equal(event.payload["Tlh.Subagent.librarian.thinking"], "unknown");
});

test("launch telemetry reflects hand-edited frontmatter thinking value", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);

	// Simulate an installed subagent file with user-edited thinking field
	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "librarian.md"),
		"---\nname: librarian\nthinking: medium\nmodel: claude-opus-4-5\n---\nPrompt body here.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.librarian.thinking"], "medium", "frontmatter thinking should be reflected");
	assert.equal(event.payload["Tlh.Subagent.librarian.model"], "claude-opus-4-5", "frontmatter model should be reflected");
});

test("launch telemetry: settings agentOverrides wins over frontmatter", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);

	// Frontmatter says "low"; settings override says "max"
	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "oracle.md"),
		"---\nname: oracle\nthinking: low\nmodel: gpt-4o\n---\nPrompt body.\n",
	);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({
			subagents: { agentOverrides: { oracle: { thinking: "max", model: "claude-opus-4-5" } } },
		}, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.oracle.thinking"], "max", "settings override should win over frontmatter");
	assert.equal(event.payload["Tlh.Subagent.oracle.model"], "claude-opus-4-5", "settings override model should win over frontmatter");
});

test("launch telemetry: disabled agentOverride is reported as 'disabled' for both keys", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({
			subagents: { agentOverrides: { "repo-scout": { disabled: true } } },
		}, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// "disabled" does not collide with any THINKING_LEVELS member
	assert.equal(event.payload["Tlh.Subagent.repo-scout.thinking"], "disabled");
	assert.equal(event.payload["Tlh.Subagent.repo-scout.model"], "disabled");
});

test("launch telemetry never emits keys for agent names outside the bundled eight", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({
			// "skunkworks" is not a bundled subagent name
			subagents: { agentOverrides: { skunkworks: { thinking: "high", model: "secret-model" } } },
		}, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	const payloadKeys = Object.keys(event.payload);
	const unbundledKeys = payloadKeys.filter((k) => k.startsWith("Tlh.Subagent.") && k.includes("skunkworks"));
	assert.equal(unbundledKeys.length, 0, "no telemetry key should exist for non-bundled agent name");
});

test("launch telemetry: non-public model in frontmatter is reported as 'custom'", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-subagent-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "contrarian.md"),
		"---\nname: contrarian\nthinking: high\nmodel: acme-internal/super-secret-model\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// The model is provider-qualified so it must be in availableModels to be reported.
				// privacySafeTlhTelemetryModelId then redacts it as "custom" (not on allowlist).
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					availableModels: [{ provider: "acme-internal", id: "super-secret-model" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.contrarian.thinking"], "high");
	// The model is in availableModels so it is resolved, then redacted by the privacy filter.
	assert.equal(event.payload["Tlh.Subagent.contrarian.model"], "custom");
});

// ── provider-aware frontmatter tests ────────────────────────────────────────

test("launch telemetry reports provider-aware defaults for bundled agents (Anthropic active)", async (t) => {
	// developer.md: tlhAnthropicThinking=medium, tlhOpenaiThinking=max
	//               tlhAnthropicModels=anthropic/claude-sonnet-4-6, tlhOpenaiModels=openai-codex/gpt-5.6-luna
	// Expected for Anthropic provider: thinking=medium, model=claude-sonnet-4-6
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\ntlhOpenaiThinking: max\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Supply the real available-models list; only models present here can be reported.
				// This mirrors how scheduleTlhLaunchTelemetry captures the registry at schedule time.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// Anthropic provider: tlhAnthropicThinking=medium, model resolved against the real
	// available list (claude-sonnet-4-6 IS available here).
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "medium", "Anthropic: expected medium thinking");
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "claude-sonnet-4-6", "Anthropic: expected claude-sonnet-4-6 model");
});

test("launch telemetry reports provider-aware defaults for bundled agents (OpenAI active)", async (t) => {
	// Same frontmatter as above but with OpenAI provider
	// Expected: thinking=max, model=gpt-5.6-luna
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\ntlhOpenaiThinking: max\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Supply the real available-models list so resolver can find openai-codex model.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "openai-codex",
					availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// OpenAI-codex provider: tlhOpenaiThinking=max, model resolved against the real
	// available list (gpt-5.6-luna IS available here).
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "max", "OpenAI: expected max thinking");
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "gpt-5.6-luna", "OpenAI: expected gpt-5.6-luna model");
	// Verify they differ from Anthropic (developer is the canonical case where they diverge)
	assert.notEqual(
		event.payload["Tlh.Subagent.developer.thinking"],
		"medium",
		"OpenAI thinking should differ from Anthropic thinking for developer",
	);
});

test("launch telemetry handles quoted frontmatter model values", async (t) => {
	// tlhAnthropicModels value is quoted in YAML: 'anthropic/claude-sonnet-4-6'
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "librarian.md"),
		"---\nname: librarian\ntlhAnthropicModels: 'anthropic/claude-haiku-4-5'\ntlhAnthropicThinking: \"high\"\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Supply the model as available so the registry-based resolver can select it.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// Quoted frontmatter values must be unquoted correctly; model resolved against available list.
	assert.equal(event.payload["Tlh.Subagent.librarian.thinking"], "high", "quoted thinking value should be parsed correctly");
	assert.equal(event.payload["Tlh.Subagent.librarian.model"], "claude-haiku-4-5", "quoted model value should be parsed correctly");
});

test("launch telemetry handles list-valued model fields (comma-separated tlhOpenaiModels)", async (t) => {
	// tlhOpenaiModels contains a comma-separated list; the first matching provider entry is used
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-provider-aware-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "oracle.md"),
		"---\nname: oracle\ntlhOpenaiModels: openai-codex/gpt-5.6-sol, openai/gpt-4o\ntlhAnthropicModels: anthropic/claude-opus-5\ntlhOpenaiThinking: high\ntlhAnthropicThinking: high\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Supply openai-codex/gpt-5.6-sol as available; the resolver must pick it first
				// over openai/gpt-4o since it matches the current provider more precisely.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "openai-codex",
					availableModels: [
						{ provider: "openai-codex", id: "gpt-5.6-sol" },
						{ provider: "openai", id: "gpt-4o" },
					],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// First matching openai-codex entry from the comma-separated list is selected (available in registry).
	assert.equal(event.payload["Tlh.Subagent.oracle.model"], "gpt-5.6-sol", "first matching openai-codex model from list should be selected");
	assert.equal(event.payload["Tlh.Subagent.oracle.thinking"], "high");
});

test("launch telemetry: model: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-clearing-", { test: t });
	writeTelemetryState(fixture);

	// Install frontmatter with a real model value
	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);
	// Settings override clears the model explicitly
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { model: false } } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// false model override must report "cleared", not fall back to frontmatter value
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "cleared", "model: false must report 'cleared'");
	// thinking override is absent so frontmatter value is used
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "medium", "thinking should still come from frontmatter");
});

test("launch telemetry: thinking: false clearing override reports 'cleared', not the frontmatter value", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-clearing-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: false } } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Provide the model as available so the registry-based resolver can find it
				// and the test demonstrates that only thinking is cleared, not model.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// false thinking override must report "cleared", not fall back to frontmatter value
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "cleared", "thinking: false must report 'cleared'");
	// model override is absent so frontmatter value is used.
	// The model (anthropic/claude-sonnet-4-6) is in availableModels in the snapshot, so it
	// is resolved and reported; this demonstrates that only thinking is cleared, not model.
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "claude-sonnet-4-6", "model should still come from frontmatter");
});

test("launch telemetry: settings override wins over provider-aware frontmatter", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-override-wins-", { test: t });
	writeTelemetryState(fixture);

	// Frontmatter has provider-aware keys
	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);
	// Settings override should win over frontmatter values
	writeFileSync(
		join(fixture.agent, "settings.json"),
		`${JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high", model: "anthropic/claude-opus-5" } } } }, null, 2)}\n`,
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "high", "settings override thinking should win over frontmatter");
	// model "anthropic/claude-opus-5" → last segment "claude-opus-5" → matches claude-* pattern
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "claude-opus-5", "settings override model should win over frontmatter");
});

// ── registry-accurate resolution tests ──────────────────────────────────────

test("registry-accurate: provider-aware candidate NOT available is reported as 'unknown'", async (t) => {
	// When availableModels does NOT include the frontmatter-declared model, the resolver
	// cannot select it, so telemetry must report 'unknown' rather than the frontmatter value.
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// availableModels does NOT include anthropic/claude-sonnet-4-6.
				// The resolver cannot select it, so model must be "unknown".
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }], // different model
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// Model was NOT in the available list → unknown (a plausible-but-wrong value is worse than unknown).
	// Thinking still resolves from provider key because it does not depend on model availability.
	assert.equal(event.payload["Tlh.Subagent.developer.model"], "unknown", "unavailable model must resolve to unknown");
	assert.equal(event.payload["Tlh.Subagent.developer.thinking"], "medium", "thinking resolves from provider key regardless of model availability");
});

test("registry-accurate: empty availableModels yields 'unknown' for provider-qualified model fields", async (t) => {
	// When the registry was not captured (empty availableModels), provider-qualified model
	// references cannot be verified and must not be guessed — report 'unknown'.
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "librarian.md"),
		"---\nname: librarian\ntlhAnthropicModels: anthropic/claude-haiku-4-5\ntlhAnthropicThinking: low\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// No availableModels in snapshot (defaults to []). Provider-qualified model
				// references cannot be found → must report 'unknown', not the frontmatter value.
				await sendTlhLaunchTelemetry({ version: "1.2.3", providerId: "anthropic" });
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	assert.equal(event.payload["Tlh.Subagent.librarian.model"], "unknown", "empty registry must yield unknown for provider-qualified models");
	// thinking still resolves correctly from provider key
	assert.equal(event.payload["Tlh.Subagent.librarian.thinking"], "low");
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model IS available is reported", async (t) => {
	// When preferOppositeProvider is true and the opposite-provider model is in availableModels,
	// it is selected and reported (this is the correct runtime behaviour).
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "contrarian.md"),
		"---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Provider is anthropic; preferOppositeProvider → looks for openai-codex model.
				// openai-codex/gpt-5.6-luna IS available here, so it must be selected.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// preferOppositeProvider + anthropic provider → openai-codex model selected
	assert.equal(event.payload["Tlh.Subagent.contrarian.model"], "gpt-5.6-luna");
	// Thinking resolves for the selected model's provider (openai-codex → tlhOpenaiThinking=max)
	assert.equal(event.payload["Tlh.Subagent.contrarian.thinking"], "max");
});

test("registry-accurate: preferOppositeProvider agent — opposite-provider model NOT available yields same-provider fallback", async (t) => {
	// Old code (synthetic list) incorrectly reported the opposite-provider model even when it
	// was not in the real registry. With the real registry, if the opposite-provider model is
	// unavailable the resolver falls through to the standard same-provider selection.
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "contrarian.md"),
		"---\nname: contrarian\npreferOppositeProvider: true\ntlhOpenaiModels: openai-codex/gpt-5.6-luna\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhOpenaiThinking: max\ntlhAnthropicThinking: medium\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Provider is anthropic; preferOppositeProvider → looks for openai-codex model.
				// openai-codex/gpt-5.6-luna is NOT available, so the opposite-provider selection
				// fails and the resolver falls back to the standard same-provider selection.
				// anthropic/claude-sonnet-4-6 IS available, so it is reported as the fallback.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// Old synthetic code would have wrongly reported gpt-5.6-luna here.
	// New registry-accurate code correctly reports the same-provider fallback.
	assert.notEqual(event.payload["Tlh.Subagent.contrarian.model"], "gpt-5.6-luna", "unavailable opposite-provider model must not be reported");
	assert.equal(event.payload["Tlh.Subagent.contrarian.model"], "claude-sonnet-4-6", "same-provider fallback selected when opposite-provider model unavailable");
	// Thinking resolves for the selected model's provider (anthropic → tlhAnthropicThinking=medium)
	assert.equal(event.payload["Tlh.Subagent.contrarian.thinking"], "medium");
});

test("registry-accurate: hand-edited generic model: field wins when provider-aware models unavailable", async (t) => {
	// When tlhAnthropicModels / tlhOpenaiModels are all absent from availableModels but the
	// generic model: field IS in the registry, the generic field wins. This is the same
	// precedence as selectStandardProviderAwareAgentModel which checks agent.model first.
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-registry-", { test: t });
	writeTelemetryState(fixture);

	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "oracle.md"),
		// model: is provider-qualified; tlhAnthropicModels is a different model that
		// is NOT in availableModels. The generic model: field must win here.
		"---\nname: oracle\nmodel: anthropic/claude-opus-5\ntlhAnthropicModels: anthropic/claude-sonnet-4-6\ntlhAnthropicThinking: high\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// availableModels contains only the generic model: field's model.
				// tlhAnthropicModels refers to claude-sonnet-4-6 which is NOT available.
				// selectStandardProviderAwareAgentModel checks agent.model first, so claude-opus-5 wins.
				await sendTlhLaunchTelemetry({
					version: "1.2.3",
					providerId: "anthropic",
					availableModels: [{ provider: "anthropic", id: "claude-opus-5" }],
				});
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}

	assert.ok(request, "expected telemetry fetch call");
	const [event] = JSON.parse(request.options?.body ?? "[]");
	// The generic model: field IS available in the registry and is checked first by
	// selectStandardProviderAwareAgentModel, so it wins over the unavailable tlhAnthropicModels.
	assert.equal(event.payload["Tlh.Subagent.oracle.model"], "claude-opus-5", "generic model: field wins when it is the only available model");
	// Thinking: with only the generic model available, resolveThinkingForProvider uses the
	// selected model's provider (anthropic) → tlhAnthropicThinking=high.
	assert.equal(event.payload["Tlh.Subagent.oracle.thinking"], "high");
});

// ── deferral tests ───────────────────────────────────────────────────────────

test("scheduleTlhLaunchTelemetry does not read subagent frontmatter files synchronously", () => {
	// Frontmatter reads (readSubagentFrontmatterConfig) must only happen inside
	// sendTlhLaunchTelemetry / buildSubagentTelemetryPayload, which are called from the
	// deferred setTimeout callback. This verifies that the synchronous body of
	// scheduleTlhLaunchTelemetry does not contain any path referencing the subagent install dir.
	const source = readFileSync(new URL("../extensions/the-last-harness/launch-telemetry.ts", import.meta.url), "utf8");

	// Extract the scheduleTlhLaunchTelemetry function body up to (but not including) the
	// setTimeout callback — everything before the arrow function argument.
	const scheduleStart = source.indexOf("export function scheduleTlhLaunchTelemetry(");
	assert.notEqual(scheduleStart, -1, "scheduleTlhLaunchTelemetry must exist");

	// Find the setTimeout call in the function. Everything before it is synchronous.
	const setTimeoutIndex = source.indexOf("const timer = setTimeout(", scheduleStart);
	assert.notEqual(setTimeoutIndex, -1, "setTimeout must exist in scheduleTlhLaunchTelemetry");

	const syncBody = source.slice(scheduleStart, setTimeoutIndex);

	// The sync body must not contain frontmatter-related paths or read calls
	assert.doesNotMatch(syncBody, /tlh\/agents\/subagents/, "frontmatter path must not appear in synchronous scheduleTlhLaunchTelemetry body");
	assert.doesNotMatch(syncBody, /buildSubagentTelemetryPayload/, "subagent payload builder must not be called synchronously");
	assert.doesNotMatch(syncBody, /readSubagentFrontmatterConfig/, "frontmatter reader must not be called synchronously");

	// Verify the deferred path DOES contain the subagent build call
	const deferredStart = source.indexOf("export async function sendTlhLaunchTelemetry(");
	assert.notEqual(deferredStart, -1, "sendTlhLaunchTelemetry must exist");
	const deferredEnd = source.indexOf("\nexport function scheduleTlhLaunchTelemetry", deferredStart);
	const deferredBody = deferredEnd === -1 ? source.slice(deferredStart) : source.slice(deferredStart, deferredEnd);
	assert.match(deferredBody, /buildSubagentTelemetryPayload/, "buildSubagentTelemetryPayload must appear in the deferred sendTlhLaunchTelemetry path");
});

test("scheduleTlhLaunchTelemetry defers subagent frontmatter reads: no fetch before timer fires, fetch occurs after (behavioural)", async (t) => {
	// BEHAVIOURAL deferral test. The source-text assertion above proves structure;
	// this test proves the property at runtime: no settings read, no subagent
	// frontmatter read, and no fetch call may occur before the deferred timer fires.
	//
	// Observation mechanism: file-swap / late-write technique. We write SETTINGS_A to
	// settings.json BEFORE calling scheduleTlhLaunchTelemetry, then IMMEDIATELY (in the
	// same synchronous turn of the event loop, before any await) write SETTINGS_B.
	// The key property of sendTlhLaunchTelemetry: its very first statement is a
	// synchronous `readTlhLaunchSettings()` call — BEFORE the first `await`. With
	// correct deferral, that call only happens inside the timer callback, AFTER the swap
	// (gets SETTINGS_B). With deferral removed the call happens synchronously INSIDE
	// scheduleTlhLaunchTelemetry, BEFORE the swap (gets SETTINGS_A). The telemetry
	// payload then proves which settings were used, making the assertion fail for the
	// non-deferred regression.
	//
	// Why it cannot pass vacuously:
	// - If no settings read occurs → payload uses default thinking=unknown → assertion fails.
	// - If settings are read with SETTINGS_A → payload thinking="low" → assertion fails.
	// - Only if settings are read with SETTINGS_B → payload thinking="high" → assertion passes.
	// There is no way for the assertion to pass without a REAL readTlhLaunchSettings call
	// that happens AFTER the swap (i.e., inside the deferred callback).
	//
	// Why direct readFileSync spy is not used: jiti resolves `node:fs` via a native ESM
	// namespace object that is separate from and not affected by patching
	// require("node:fs"). The namespace is immutable ([object Module]); there is no way
	// to intercept readFileSync calls from jiti-loaded modules from outside. The
	// file-swap approach bypasses this by observing the EFFECT of the read (settings
	// content reflected in payload) rather than the read mechanism itself.
	//
	// Note: scheduleTlhLaunchTelemetry has a module-level sentTlhLaunchTelemetry guard
	// (one-shot dedup). This is the only test that calls it so the guard does not
	// interfere.
	const fixture = createIsolatedProfileFixture("tlh-launch-telemetry-deferral-behav-", { test: t });
	writeTelemetryState(fixture);

	// SETTINGS_A: active when scheduleTlhLaunchTelemetry is called. With deferral removed,
	// readTlhLaunchSettings runs synchronously inside the call and reads this content.
	// The settings structure follows the schema parsed by readTlhLaunchSettings:
	// { subagents: { agentOverrides: { <name>: { thinking, model } } } }
	const settingsPath = join(fixture.agent, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "low" } } } }) + "\n");

	// Write a subagent frontmatter file so that buildSubagentTelemetryPayload has
	// genuine file I/O to perform and the scenario is not trivially opt-out.
	// (With a settings override present, frontmatter is still read for other fields;
	// the file also ensures the scenario is non-trivial regardless of override logic.)
	const subagentDir = join(fixture.agent, "tlh", "agents", "subagents");
	mkdirSync(subagentDir, { recursive: true });
	writeFileSync(
		join(subagentDir, "developer.md"),
		"---\nname: developer\nthinking: medium\nmodel: claude-opus-4-5\n---\nBody.\n",
	);

	const previousFetch = globalThis.fetch;
	let fetchCallCount = 0;
	let capturedFetchBody = null;
	globalThis.fetch = async (_url, options) => {
		capturedFetchBody = options?.body ?? null;
		fetchCallCount++;
		return { ok: true, status: 200, statusText: "OK" };
	};

	try {
		await withEnv(
			{
				HOME: fixture.home,
				PI_CODING_AGENT_DIR: fixture.agent,
				TLH_TELEMETRY_NAMESPACE: "test-namespace",
				TLH_TELEMETRY_APP_ID: "test-app-id",
				TLH_TELEMETRY_INGEST_BASE_URL: "https://telemetry.example.test/namespace/",
				PI_OFFLINE: undefined,
				TLH_SKIP_TELEMETRY: undefined,
				TLH_TELEMETRY_DISABLED: undefined,
				PI_TELEMETRY: undefined,
			},
			async () => {
				// Hold the setTimeout so the deferred work cannot fire yet.
				// `now: Date.now()` is required: plain `enable(["setTimeout"])` mocks
				// Date.now() to return 0 (epoch). While the Date mock does not affect
				// sendTlhLaunchTelemetry directly, the pattern is made explicit here
				// for consistency and to guard against future logic that may use
				// Date.now() inside the deferred callback.
				t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });

				// Minimal ExtensionContext stub — only the fields scheduleTlhLaunchTelemetry reads.
				// modelRegistry: null is a valid input to getUnfilteredAvailableModels which
				// gracefully returns [] for falsy inputs (no I/O, just an in-memory guard).
				const mockCtx = { model: { provider: "anthropic", id: "claude-opus-4-5" }, thinkingLevel: "medium", modelRegistry: null };
				scheduleTlhLaunchTelemetry(mockCtx, "architect");

				// SETTINGS_B written SYNCHRONOUSLY (no await between here and the call above).
				// With correct deferral, readTlhLaunchSettings has not yet run (timer pending);
				// it will run inside the timer callback and will see SETTINGS_B (thinking=high).
				// With deferral removed, readTlhLaunchSettings already ran above (thinking=low);
				// this overwrite is too late to affect the captured launchSettings.
				writeFileSync(settingsPath, JSON.stringify({ subagents: { agentOverrides: { developer: { thinking: "high" } } } }) + "\n");

				// BEFORE the timer fires: no fetch call should have occurred.
				assert.equal(fetchCallCount, 0, "no fetch calls should occur before the deferred timer fires");

				// Fire the captured timer. sendTlhLaunchTelemetry starts running;
				// it reads settings (SETTINGS_B due to the swap above) and eventually calls fetch.
				t.mock.timers.tick(0);

				// Restore real timers before draining so that async operations
				// (getTlhOsMetadata spawns sw_vers, sendTlhTelemetry calls fetch)
				// can complete normally.
				t.mock.timers.reset();

				// Drain the async continuation deterministically: each setImmediate
				// yield gives the event loop one cycle to process pending I/O and
				// microtasks (including the sw_vers child-process exit and fetch).
				// The deadline guards against an infinite loop on unexpected failures.
				const drainDeadline = Date.now() + 5000;
				while (fetchCallCount === 0 && Date.now() < drainDeadline) {
					await new Promise((resolve) => setImmediate(resolve));
				}

				// AFTER the timer fires: settings were read (SETTINGS_B) and fetch was called.
				assert.ok(
					fetchCallCount > 0,
					"fetch should have been called after the deferred timer fires",
				);

				// Primary deferral assertion: the telemetry payload must reflect SETTINGS_B
				// (thinking=high), not SETTINGS_A (thinking=low). This can only be true if
				// readTlhLaunchSettings ran AFTER the file swap — i.e., inside the deferred
				// timer callback, not synchronously inside scheduleTlhLaunchTelemetry.
				const events = JSON.parse(capturedFetchBody ?? "[]");
				const event = events[0];
				assert.ok(event, "fetch body must contain at least one telemetry event");
				assert.equal(
					event.payload["Tlh.Subagent.developer.thinking"],
					"high",
					"Tlh.Subagent.developer.thinking must be 'high' (from SETTINGS_B), not 'low' (SETTINGS_A) or 'unknown' — " +
					"proving readTlhLaunchSettings ran inside the deferred timer callback, not synchronously before it",
				);
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
		// Ensure mock timers are always restored (idempotent after reset()).
		try { t.mock.timers.reset(); } catch { /* already reset */ }
	}
});
