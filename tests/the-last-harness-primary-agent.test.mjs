import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_PRIMARY_AGENT,
	DISABLED_PRIMARY_AGENT,
	PRIMARY_AGENT_CYCLE,
	PRIMARY_AGENT_SESSION_STATE_ENTRY,
	nextPrimaryAgentSelection,
	primaryAgentDefaultLabel,
	primaryAgentSelectionFromBranch,
	resolvePrimaryAgentConfig,
	resolvePrimaryAgentSessionState,
} from "../extensions/the-last-harness-primary-agent.mjs";

test("primary-agent config defaults to architect without settings", () => {
	assert.equal(resolvePrimaryAgentConfig(undefined).selection, DEFAULT_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentConfig({}).selection, DEFAULT_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentConfig({ enabled: true }).selection, DEFAULT_PRIMARY_AGENT);
	assert.equal(primaryAgentDefaultLabel(undefined), "unset (TLH default: architect)");
});

test("primary-agent config supports rush, product, and disabled while preserving enabled=false compatibility", () => {
	assert.equal(resolvePrimaryAgentConfig({ selected: "rush" }).selection, "rush");
	assert.equal(resolvePrimaryAgentConfig({ enabled: true, selected: "rush" }).selection, "rush");
	assert.equal(resolvePrimaryAgentConfig({ selected: "product" }).selection, "product");
	assert.equal(resolvePrimaryAgentConfig({ enabled: true, selected: "product" }).selection, "product");
	assert.equal(resolvePrimaryAgentConfig({ selected: "disabled" }).selection, DISABLED_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentConfig({ enabled: false }).selection, DISABLED_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentConfig({ enabled: false, selected: "product" }).selection, DISABLED_PRIMARY_AGENT);
});

test("invalid persistent primary names fall back to architect with a diagnostic", () => {
	assert.deepEqual(resolvePrimaryAgentConfig({ selected: "planner" }), {
		selection: DEFAULT_PRIMARY_AGENT,
		invalidSelected: "planner",
	});
	assert.equal(primaryAgentDefaultLabel({ selected: "planner" }), 'invalid "planner" (TLH fallback: architect)');
});

test("session primary state preserves old enabled booleans and supports selected primaries", () => {
	assert.deepEqual(resolvePrimaryAgentSessionState({}), {});
	assert.equal(resolvePrimaryAgentSessionState(true).selection, DEFAULT_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentSessionState(false).selection, DISABLED_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentSessionState({ enabled: true }).selection, DEFAULT_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentSessionState({ enabled: false }).selection, DISABLED_PRIMARY_AGENT);
	assert.equal(resolvePrimaryAgentSessionState({ selected: "rush" }).selection, "rush");
	assert.equal(resolvePrimaryAgentSessionState({ enabled: true, selected: "rush" }).selection, "rush");
	assert.equal(resolvePrimaryAgentSessionState({ selected: "product" }).selection, "product");
	assert.equal(resolvePrimaryAgentSessionState({ enabled: true, selected: "product" }).selection, "product");
});

test("latest session primary state wins over earlier compatibility entries", () => {
	assert.deepEqual(
		primaryAgentSelectionFromBranch([
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { enabled: false } },
			{ type: "message", data: { selected: "product" } },
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "product" } },
		]),
		{ selection: "product" },
	);
	assert.deepEqual(
		primaryAgentSelectionFromBranch([
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: { selected: "product" } },
			{ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data: {} },
		]),
		{},
	);
});

test("Shift+Tab cycle order is architect to rush to product to bug-hunter to disabled", () => {
	assert.deepEqual(PRIMARY_AGENT_CYCLE, ["architect", "rush", "product", "bug-hunter", "disabled"]);
	assert.equal(nextPrimaryAgentSelection("architect"), "rush");
	assert.equal(nextPrimaryAgentSelection("rush"), "product");
	assert.equal(nextPrimaryAgentSelection("product"), "bug-hunter");
	assert.equal(nextPrimaryAgentSelection("bug-hunter"), "disabled");
	assert.equal(nextPrimaryAgentSelection("disabled"), "architect");
});
