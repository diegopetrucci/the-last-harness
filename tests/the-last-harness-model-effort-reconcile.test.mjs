import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
	computeModelEffortDrift,
	readReconcileState,
	writeReconcileState,
	updateReconcileAcknowledgedSnapshot,
	tlhReconcileStatePath,
} = await jiti.import("../extensions/the-last-harness/model-effort-reconcile.ts");
const { selectProviderAwareAgentDefaults, parseProviderModelReference, splitKnownThinkingSuffix } = await jiti.import(
	"../extensions/the-last-harness/model-defaults.ts",
);

/**
 * Mirrors the module's synthetic "all packaged models available" registry so the
 * parity test can call the production selector directly.
 */
function packagedCandidateModelsForFixture(agent) {
	const seen = new Map();
	for (const raw of [agent.model, ...(agent.tlhOpenaiModels ?? []), ...(agent.tlhAnthropicModels ?? [])]) {
		const parsed = parseProviderModelReference(splitKnownThinkingSuffix(raw).baseModel);
		if (!parsed) continue;
		const key = `${parsed.provider}/${parsed.id}`;
		if (!seen.has(key)) seen.set(key, parsed);
	}
	return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Shared agent fixtures (production types — drift is caught if shapes change)
// ---------------------------------------------------------------------------

/** @type {import("../extensions/the-last-harness/types.ts").AgentPrompt} */
const architectAgent = {
	name: "architect",
	description: "Primary architect agent",
	model: "anthropic/claude-opus-5",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-5"],
	tlhAnthropicThinking: "high",
	tlhOpenaiThinking: "high",
	tools: [],
	systemPrompt: "",
	filePath: "/fake/agents/primary/architect.md",
};

/** @type {import("../extensions/the-last-harness/types.ts").AgentPrompt} */
const rushAgent = {
	name: "rush",
	description: "Rush primary agent",
	model: "anthropic/claude-sonnet-4-6",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
	thinking: "low",
	tools: [],
	systemPrompt: "",
	filePath: "/fake/agents/primary/rush.md",
};

/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
const developerSubagent = {
	name: "developer",
	description: "Developer subagent",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
	tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
	tlhAnthropicThinking: "medium",
	tlhOpenaiThinking: "max",
};

/** @type {import("../extensions/the-last-harness/types.ts").SubagentMetadata} */
const codeReviewerSubagent = {
	name: "code-reviewer",
	description: "Code reviewer subagent",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
	tlhAnthropicModels: ["anthropic/claude-opus-5"],
	preferOppositeProvider: true,
};

/**
 * Mirrors agents/primary/rush.md, which sets preferCurrentOpenaiModel alongside an
 * anthropic `model`. Kept separate from rushAgent so the plain fallback tests stay
 * focused on generic thinking resolution.
 * @type {import("../extensions/the-last-harness/types.ts").AgentPrompt}
 */
const rushOpenaiAgent = {
	name: "rush-openai",
	description: "Rush primary agent with preferCurrentOpenaiModel",
	model: "anthropic/claude-sonnet-4-6",
	tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
	tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
	preferCurrentOpenaiModel: true,
	thinking: "low",
	tools: [],
	systemPrompt: "",
	filePath: "/fake/agents/primary/rush-openai.md",
};

const primaryAgents = new Map([
	["architect", architectAgent],
	["rush", rushAgent],
	["rush-openai", rushOpenaiAgent],
]);

const subagentMetadata = [developerSubagent, codeReviewerSubagent];

// ---------------------------------------------------------------------------
// computeModelEffortDrift
// ---------------------------------------------------------------------------

test("no overrides → empty drift", () => {
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, {});
	assert.deepEqual(result, []);
});

test("empty agentOverrides object → empty drift", () => {
	const settings = { subagents: { agentOverrides: {} } };
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
	assert.deepEqual(result, []);
});

test("subagent override with no model or thinking fields → skipped", () => {
	const settings = { subagents: { agentOverrides: { developer: {} } } };
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
	assert.deepEqual(result, []);
});

// --- Primary agent overrides ---

test("primary override drift — model override with anthropic provider", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.role, "primary");
	assert.equal(entry.name, "architect");
	assert.deepEqual(entry.override, { model: "anthropic/claude-sonnet-4-6" });
	assert.equal(entry.packaged.model, "anthropic/claude-opus-5");
	assert.equal(entry.packaged.thinking, "high");
	assert.equal(entry.packagedDefaultsChanged, false);
});

test("primary override drift — explicit frontmatter `model` wins over the provider list", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.6-luna" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "openai-codex");
	assert.equal(entry.role, "primary");
	assert.equal(entry.name, "architect");
	// architect declares `model: anthropic/claude-opus-5`. selectProviderAwareAgentDefaults
	// checks that explicit field before any provider list, so it stays the packaged default
	// even on an openai session. Reporting tlhOpenaiModels[0] here would disagree with
	// what TLH actually dispatches.
	assert.equal(entry.packaged.model, "anthropic/claude-opus-5");
	// Effort still tracks the resolved model's provider, not the session provider.
	assert.equal(entry.packaged.thinking, "high");
});

test("primary override drift — unknown agent name produces entry with empty packaged", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { "product-unknown": "anthropic/claude-opus-5" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.role, "primary");
	assert.equal(entry.name, "product-unknown");
	assert.equal(entry.packaged.model, undefined);
	assert.equal(entry.packaged.thinking, undefined);
});

test("primary override drift — empty or invalid override values are skipped", () => {
	// Only non-empty string values are valid primary overrides
	const settings = {
		tlh: {
			primaryAgent: {
				modelOverrides: {
					architect: "",
					rush: "anthropic/claude-opus-5",
				},
			},
		},
	};
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(result.length, 1);
	assert.equal(result[0].name, "rush");
});

// --- Subagent overrides ---

test("subagent model-only drift with anthropic provider", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.role, "subagent");
	assert.equal(entry.name, "developer");
	assert.deepEqual(entry.override, { model: "anthropic/claude-opus-5" });
	assert.equal(entry.packaged.model, "anthropic/claude-sonnet-4-6");
	assert.equal(entry.packaged.thinking, "medium");
	assert.equal(entry.packagedDefaultsChanged, false);
});

test("subagent thinking-only drift with anthropic provider", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.role, "subagent");
	assert.equal(entry.name, "developer");
	assert.deepEqual(entry.override, { thinking: "high" });
	assert.equal(entry.packaged.model, "anthropic/claude-sonnet-4-6");
	assert.equal(entry.packaged.thinking, "medium");
});

test("subagent model-only drift with openai provider", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "openai-codex");
	assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-luna");
	assert.equal(entry.packaged.thinking, "max");
});

test("subagent model=false override is included in drift", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: false } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.role, "subagent");
	assert.deepEqual(entry.override, { model: false });
});

test("subagent thinking=false override is included in drift", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { thinking: false } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
	assert.deepEqual(entry.override, { thinking: false });
});

test("subagent model+thinking override includes both fields", () => {
	const settings = {
		subagents: {
			agentOverrides: { developer: { model: "anthropic/claude-opus-5", thinking: "high" } },
		},
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.deepEqual(entry.override, { model: "anthropic/claude-opus-5", thinking: "high" });
});

test("subagent with no matching metadata produces entry with empty packaged", () => {
	const settings = {
		subagents: { agentOverrides: { "unknown-agent": { model: "anthropic/claude-opus-5" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(entry.name, "unknown-agent");
	assert.equal(entry.packaged.model, undefined);
	assert.equal(entry.packaged.thinking, undefined);
});

test("multiple overrides produce one entry per overridden role", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
		subagents: {
			agentOverrides: { developer: { thinking: "high" }, "code-reviewer": { model: "anthropic/claude-sonnet-4-6" } },
		},
	};
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(result.length, 3);
	const roles = result.map((e) => `${e.role}:${e.name}`);
	assert.ok(roles.includes("primary:architect"));
	assert.ok(roles.includes("subagent:developer"));
	assert.ok(roles.includes("subagent:code-reviewer"));
});

// --- Provider-aware defaults: no provider → falls back to generic model field ---

test("subagent packaged defaults resolve without a provider via the openai list", () => {
	// developer declares no top-level `model`. With no session provider the selector
	// falls through to the openai candidate list rather than reporting "no default".
	const settings = {
		subagents: { agentOverrides: { developer: { thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings);
	assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-luna");
	// Effort follows the resolved model's provider → tlhOpenaiThinking.
	assert.equal(entry.packaged.thinking, "max");
});

// --- Regression guards: packaged defaults must honour the frontmatter selection
// flags. A private re-implementation of the selector previously ignored these and
// reported (and would have Reset to) the wrong model. ---

test("preferOppositeProvider subagent reports the opposite-provider packaged default", () => {
	const settings = {
		subagents: { agentOverrides: { "code-reviewer": { thinking: "high" } } },
	};
	// code-reviewer sets preferOppositeProvider, so on an anthropic session the packaged
	// default is the openai model — not tlhAnthropicModels[0].
	const [onAnthropic] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.equal(onAnthropic.packaged.model, "openai-codex/gpt-5.6-sol");

	// ...and symmetrically on an openai session.
	const [onOpenai] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "openai-codex");
	assert.equal(onOpenai.packaged.model, "anthropic/claude-opus-5");
});

test("preferCurrentOpenaiModel primary reports the current-provider packaged default", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { "rush-openai": "anthropic/claude-opus-5" } } },
	};
	// rush-openai mirrors agents/primary/rush.md: preferCurrentOpenaiModel with an
	// anthropic `model`. On an openai session the openai candidate must win.
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "openai-codex");
	assert.equal(entry.packaged.model, "openai-codex/gpt-5.6-luna");
});

test("packaged defaults agree with selectProviderAwareAgentDefaults across a fixture table", () => {
	// Pins this module to the production selector. If a private re-implementation is
	// ever reintroduced and diverges on any packaged agent × provider pair, this fails.
	const providers = [undefined, "anthropic", "openai-codex", "openai", "unknown-provider"];
	const agents = [...primaryAgents.values(), ...subagentMetadata, rushOpenaiAgent];

	for (const agent of agents) {
		const candidates = packagedCandidateModelsForFixture(agent);
		for (const provider of providers) {
			const expected = selectProviderAwareAgentDefaults(agent, candidates, provider);
			const settings = { subagents: { agentOverrides: { [agent.name]: { thinking: "high" } } } };
			const [entry] = computeModelEffortDrift(new Map(), [agent], settings, provider);
			const label = `${agent.name} @ ${provider ?? "no-provider"}`;
			assert.equal(
				entry.packaged.model,
				expected.model ? `${expected.model.provider}/${expected.model.id}` : undefined,
				`model mismatch for ${label}`,
			);
			assert.equal(entry.packaged.thinking, expected.thinking, `thinking mismatch for ${label}`);
		}
	}
});

test("rush primary agent falls back to generic thinking when provider is unknown", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { rush: "anthropic/claude-opus-5" } } },
	};
	// rush has generic thinking: "low" and no provider-specific thinking fields
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "unknown-provider");
	assert.equal(entry.packaged.thinking, "low");
});

// --- packagedDefaultsChanged detection ---

test("no prior acknowledgment → packagedDefaultsChanged = false", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", {});
	assert.equal(entry.packagedDefaultsChanged, false);
});

test("acknowledged snapshot matches current packaged for active provider → packagedDefaultsChanged = false", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	// byProvider-keyed snapshot matching the current packaged defaults.
	const acknowledgedSnapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, false);
});

test("acknowledged snapshot differs from current packaged for active provider → packagedDefaultsChanged = true", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	// Snapshot says packaged model was claude-opus-5 (old default), but current packaged is claude-sonnet-4-6.
	const acknowledgedSnapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "medium" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, true);
});

test("acknowledged snapshot thinking differs for active provider → packagedDefaultsChanged = true", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { thinking: "high" } } },
	};
	// Snapshot says packaged thinking was "high", but current packaged is "medium".
	const acknowledgedSnapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, true);
});

test("primary agent: snapshot differs for active provider → packagedDefaultsChanged = true", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	// Snapshot says packaged model was claude-sonnet-4-6, but current packaged is claude-opus-5.
	const acknowledgedSnapshot = {
		architect: { byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, true);
});

test("primary agent: snapshot matches current packaged for active provider → packagedDefaultsChanged = false", () => {
	const settings = {
		tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-sonnet-4-6" } } },
	};
	const acknowledgedSnapshot = {
		architect: { byProvider: { anthropic: { model: "anthropic/claude-opus-5", thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, false);
});

// --- Cross-provider regression: acknowledging under one provider must not fire a
// notice when the session switches to another provider ---

test("cross-provider: acknowledged under anthropic, no prior entry for openai → packagedDefaultsChanged = false", () => {
	// Regression guard: switching provider must never misreport a packaged-default change.
	const settings = {
		subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
	};
	// User acknowledged under anthropic; there is no entry for openai-codex yet.
	const acknowledgedSnapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } } },
	};
	// Launch under openai-codex: no prior acknowledgment for that provider → false.
	const [entry] = computeModelEffortDrift(
		primaryAgents,
		subagentMetadata,
		settings,
		"openai-codex",
		acknowledgedSnapshot,
	);
	assert.equal(entry.packagedDefaultsChanged, false, "provider switch must not fire a false notice");
});

test("cross-provider: acknowledged under openai, genuine packaged-default change for anthropic → packagedDefaultsChanged = false (different provider)", () => {
	// Regression guard: a change to a provider the user never uses must not fire a notice
	// on a session running a different provider.
	const settings = {
		subagents: { agentOverrides: { developer: { model: "openai-codex/gpt-5.6-sol" } } },
	};
	// There is an anthropic acknowledgment with a stale model, but the active session
	// is openai-codex which has no acknowledgment entry.
	const acknowledgedSnapshot = {
		developer: { byProvider: { anthropic: { model: "anthropic/old-model", thinking: "low" } } },
	};
	const [entry] = computeModelEffortDrift(
		primaryAgents,
		subagentMetadata,
		settings,
		"openai-codex",
		acknowledgedSnapshot,
	);
	assert.equal(entry.packagedDefaultsChanged, false, "stale acknowledgment for another provider must not fire");
});

test("cross-provider: acknowledged under both providers, genuine change for active provider → packagedDefaultsChanged = true", () => {
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	// Both providers have acknowledgments; active is anthropic, whose entry is now stale.
	const acknowledgedSnapshot = {
		developer: {
			byProvider: {
				anthropic: { model: "anthropic/stale-model", thinking: "medium" },
				"openai-codex": { model: "openai-codex/gpt-5.6-luna", thinking: "max" },
			},
		},
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", acknowledgedSnapshot);
	assert.equal(entry.packagedDefaultsChanged, true, "stale acknowledgment for the active provider must fire");
});

// --- Old-shape (pre-provider-keyed) state migration ---

test("old-shape snapshot (no byProvider) → packagedDefaultsChanged = false, no crash", () => {
	// Regression guard: existing reconcile-state.json written before the provider-keyed
	// upgrade must never fire a false notice.  The flat {model, thinking} fields are
	// ignored; the absence of byProvider is treated as "no prior acknowledgment".
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	const oldShapeSnapshot = {
		developer: { model: "anthropic/claude-opus-5", thinking: "medium" }, // old flat shape
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", oldShapeSnapshot);
	assert.equal(entry.packagedDefaultsChanged, false, "old-shape snapshot must not fire a false notice on upgrade");
});

test("old-shape snapshot with mismatched model → still packagedDefaultsChanged = false (migration)", () => {
	// Even if the stored flat model differs from the current packaged model, the old shape
	// must not fire — there is no provider key to compare against.
	const settings = {
		subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } },
	};
	const oldShapeSnapshot = {
		developer: { model: "anthropic/some-old-model", thinking: "low" }, // old flat shape, stale value
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", oldShapeSnapshot);
	assert.equal(entry.packagedDefaultsChanged, false, "old-shape snapshot must not trigger false notice even if stale");
});

// ---------------------------------------------------------------------------
// Reconcile state round-trip
// ---------------------------------------------------------------------------

test("readReconcileState returns empty object when outside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	// No PI_CODING_AGENT_DIR set → tlhReconcileStatePath returns undefined
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
		const state = readReconcileState();
		assert.deepEqual(state, {});
	});
});

test("writeReconcileState is a no-op when outside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
		// Should not throw; just silently skips.
		writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
		const statePath = tlhReconcileStatePath();
		assert.equal(statePath, undefined);
	});
});

test("writeReconcileState and readReconcileState round-trip inside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const state = {
			acknowledgedSnapshot: {
				architect: { model: "anthropic/claude-opus-5", thinking: "high" },
				developer: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
			},
			lastDecisionAt: "2026-08-10T16:31:00.000Z",
		};
		writeReconcileState(state);

		const statePath = tlhReconcileStatePath();
		assert.ok(statePath, "state path should be defined inside isolated profile");
		assert.ok(existsSync(statePath), "state file should exist after write");

		const read = readReconcileState();
		assert.deepEqual(read, state);
	});
});

test("readReconcileState returns empty object for invalid JSON", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		writeFileSync(statePath, "not-json", { encoding: "utf8", mode: 0o600 });
		const read = readReconcileState();
		assert.deepEqual(read, {});
	});
});

test("readReconcileState returns empty object for non-object JSON", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		writeFileSync(statePath, '"just a string"', { encoding: "utf8", mode: 0o600 });
		const read = readReconcileState();
		assert.deepEqual(read, {});
	});
});

test("writeReconcileState stores file with mode 600", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
		const statePath = tlhReconcileStatePath();
		const { lstatSync } = await import("node:fs");
		const stat = lstatSync(statePath);
		assert.equal(stat.mode & 0o777, 0o600);
	});
});

// ---------------------------------------------------------------------------
// updateReconcileAcknowledgedSnapshot
// ---------------------------------------------------------------------------

test("updateReconcileAcknowledgedSnapshot merges into existing state", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		// Write initial state with one entry
		writeReconcileState({
			acknowledgedSnapshot: {
				architect: { model: "anthropic/claude-opus-5", thinking: "high" },
			},
		});

		// Update with a second entry and a lastDecisionAt
		updateReconcileAcknowledgedSnapshot(
			{ developer: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" } },
			"2026-08-10T16:31:00.000Z",
		);

		const state = readReconcileState();
		assert.deepEqual(state.acknowledgedSnapshot?.architect, {
			model: "anthropic/claude-opus-5",
			thinking: "high",
		});
		assert.deepEqual(state.acknowledgedSnapshot?.developer, {
			model: "anthropic/claude-sonnet-4-6",
			thinking: "medium",
		});
		assert.equal(state.lastDecisionAt, "2026-08-10T16:31:00.000Z");
	});
});

test("updateReconcileAcknowledgedSnapshot overwrites existing snapshot for same role", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeReconcileState({
			acknowledgedSnapshot: {
				architect: { model: "anthropic/claude-opus-5", thinking: "high" },
			},
		});

		updateReconcileAcknowledgedSnapshot({
			architect: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
		});

		const state = readReconcileState();
		assert.equal(state.acknowledgedSnapshot?.architect?.model, "openai-codex/gpt-5.6-sol");
	});
});

test("updateReconcileAcknowledgedSnapshot without lastDecisionAt preserves existing one", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
		updateReconcileAcknowledgedSnapshot({ developer: { model: "anthropic/claude-sonnet-4-6" } });
		const state = readReconcileState();
		assert.equal(state.lastDecisionAt, "2026-01-01T00:00:00.000Z");
	});
});

// ---------------------------------------------------------------------------
// Boundary validation: malformed subagent override values
// ---------------------------------------------------------------------------

test("malformed subagent override: model=null is treated as absent and entry is skipped", () => {
	// null is not a valid override value — the entry should be omitted, not displayed.
	const settings = { subagents: { agentOverrides: { developer: { model: null } } } };
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.deepEqual(result, [], "null model must not produce a drift entry");
});

test("malformed subagent override: model=42 is stripped, valid thinking is preserved", () => {
	// A number model is invalid; if thinking is also provided and valid, it should still show.
	const settings = {
		subagents: { agentOverrides: { developer: { model: 42, thinking: "high" } } },
	};
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.ok(entry, "entry with valid thinking must be produced even when model is invalid");
	assert.equal(entry.override.model, undefined, "invalid model must be stripped from override");
	assert.equal(entry.override.thinking, "high", "valid thinking must survive");
});

test("malformed subagent override: thinking=null is treated as absent and entry is skipped when model is also absent", () => {
	const settings = { subagents: { agentOverrides: { developer: { thinking: null } } } };
	const result = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.deepEqual(result, [], "null thinking with no other override must produce no drift entry");
});

test("malformed subagent override: model=false still counts as a valid override", () => {
	// false is a legitimate disable value for subagent model overrides.
	const settings = { subagents: { agentOverrides: { developer: { model: false } } } };
	const [entry] = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic");
	assert.ok(entry, "model=false must produce a drift entry");
	assert.deepEqual(entry.override, { model: false });
});

// ---------------------------------------------------------------------------
// Boundary validation: malformed reconcile-state entries
// ---------------------------------------------------------------------------

test("readReconcileState: null acknowledgedSnapshot entry is silently dropped", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		// Manually write a state file with a null snapshot entry.
		writeFileSync(
			statePath,
			JSON.stringify({
				acknowledgedSnapshot: {
					developer: null,
					architect: { byProvider: { anthropic: { model: "m", thinking: "high" } } },
				},
				lastDecisionAt: "2026-01-01T00:00:00.000Z",
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		const state = readReconcileState();
		// null entry must be dropped; the valid entry must survive.
		assert.equal(state.acknowledgedSnapshot?.developer, undefined, "null entry must be dropped");
		assert.ok(state.acknowledgedSnapshot?.architect, "valid entry must survive");
		assert.equal(state.lastDecisionAt, "2026-01-01T00:00:00.000Z", "other top-level fields preserved");
	});
});

test("readReconcileState: null byProvider entry is dropped to prevent downstream crash", async (t) => {
	// Regression: providerEntry.model would throw TypeError if providerEntry were null.
	// Verifies the sanitizer prevents that crash path.
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				acknowledgedSnapshot: { developer: { byProvider: { anthropic: null, "openai-codex": { model: "m" } } } },
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		const state = readReconcileState();
		// The null provider entry must be gone; the valid one must remain.
		assert.equal(
			state.acknowledgedSnapshot?.developer?.byProvider?.anthropic,
			undefined,
			"null byProvider entry must be dropped",
		);
		assert.ok(
			state.acknowledgedSnapshot?.developer?.byProvider?.["openai-codex"],
			"valid byProvider entry must survive",
		);
		// Accessing .model on the sanitized state must not throw.
		const entry = state.acknowledgedSnapshot?.developer?.byProvider?.["openai-codex"];
		assert.equal(entry?.model, "m");
	});
});

test("readReconcileState: invalid model/thinking types in byProvider are stripped", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				acknowledgedSnapshot: {
					developer: { byProvider: { anthropic: { model: 42, thinking: null, extra: "preserved" } } },
				},
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		const state = readReconcileState();
		const ack = state.acknowledgedSnapshot?.developer?.byProvider?.anthropic;
		assert.ok(ack, "ack entry must exist");
		assert.equal(ack.model, undefined, "invalid model type must be stripped");
		assert.equal(ack.thinking, undefined, "invalid thinking type must be stripped");
		// Unknown extra fields within the entry must be preserved.
		assert.equal(ack.extra, "preserved", "unknown fields must be preserved");
	});
});

test("readReconcileState: malformed state does not crash computeModelEffortDrift", async (t) => {
	// End-to-end guard: a state file with null byProvider entries must not throw
	// when passed to the drift comparator (which accesses providerEntry.model).
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const statePath = tlhReconcileStatePath();
		mkdirSync(join(statePath, ".."), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				acknowledgedSnapshot: {
					developer: { byProvider: { anthropic: null } },
				},
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		const state = readReconcileState();
		const settings = { subagents: { agentOverrides: { developer: { model: "anthropic/claude-opus-5" } } } };
		// Must not throw.
		assert.doesNotThrow(() => {
			computeModelEffortDrift(primaryAgents, subagentMetadata, settings, "anthropic", state.acknowledgedSnapshot);
		});
	});
});

// ---------------------------------------------------------------------------
// Persistence outcome: writeReconcileState and updateReconcileAcknowledgedSnapshot
// ---------------------------------------------------------------------------

test("writeReconcileState returns false when outside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
		const result = writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
		assert.equal(result, false, "writeReconcileState must return false outside isolated profile");
	});
});

test("writeReconcileState returns true when inside isolated profile and write succeeds", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const result = writeReconcileState({ lastDecisionAt: "2026-01-01T00:00:00.000Z" });
		assert.equal(result, true, "writeReconcileState must return true on successful write");
	});
});

test("updateReconcileAcknowledgedSnapshot returns false when outside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, () => {
		const result = updateReconcileAcknowledgedSnapshot({ developer: { byProvider: { anthropic: { model: "m" } } } });
		assert.equal(result, false, "updateReconcileAcknowledgedSnapshot must return false outside isolated profile");
	});
});

test("updateReconcileAcknowledgedSnapshot returns true when inside isolated profile", async (t) => {
	const fixture = createIsolatedProfileFixture("tlh-reconcile-test-", { test: t });
	await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
		const result = updateReconcileAcknowledgedSnapshot(
			{ developer: { byProvider: { anthropic: { model: "m" } } } },
			"2026-01-01T00:00:00.000Z",
		);
		assert.equal(result, true, "updateReconcileAcknowledgedSnapshot must return true on success");
	});
});
